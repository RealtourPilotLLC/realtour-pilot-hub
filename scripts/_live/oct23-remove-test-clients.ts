// ---------------------------------------------------------------------------
// LIVE ONE-OFF (Oct 23 2026): remove the "Jordan Spackman" client records and
// every synthetic TEST client, after rescuing the real business filed under
// them.
//
// Jordan, Oct 23 2026: "Remove the Jordan Spackman Client Records and all the
// test Client Records."
//
// TARGETS
//   (a) every Client whose name is a "Jordan Spackman" variant
//       (/^jordan\s+spackman\b/i: "Jordan Spackman", "Jordan Spackman TEST", …);
//   (b) every synthetic client: syntheticClientRows() (src/lib/syntheticClients.ts)
//       = the TEST / John Doe name rule in isSyntheticClientRow, unwidened.
//
// WHAT IT DOES, IN ORDER
//   1. INVENTORY. Walks every model in the Prisma datamodel and every id-like
//      String column (declared foreign keys, the schema's `// -> Model` plain
//      refs, and any *Id / *Ids / *Ref column), from each target outward until
//      nothing new turns up, and counts what points at each target directly or
//      through its rows. Ids are cuids, unique across tables, so a column can
//      only match a removed row's id if it really holds it.
//   2. STOP CONDITIONS. A target with a paid Aryeo order, a delivered real job
//      (Aryeo, not marked test by the owner, with a creative, a shoot date,
//      files or a price), Stripe or QuickBooks money rows, or a paying content
//      enrollment is NOT removed: "real business, left alone", with evidence.
//   3. RESCUE. Every CommLog, Contact, ClientAsk and SmartTask on a removed
//      client is decided one by one:
//        · from a real outside person → MOVED to that person's client, by
//          email address, then contact name, then company domain (tasks: then
//          the job they name; our sent replies: the client whose Gmail thread
//          they answer);
//        · Jordan's own mail, staff notes, mail from nobody → OWNER-ONLY, no
//          client (clientId null, minRole OWNER); Jordan's own Contact rows
//          are unlinked (clientId null);
//        · test traffic → deleted with the client.
//      Anything it cannot place is on the NEEDS A PERSON list, and --apply
//      refuses while that list is non-empty unless --accept-unplaced (which
//      makes each unplaced row owner-only / unlinked instead).
//      A row that also belongs to a REAL client (its clientId or job is
//      someone else's) is never deleted: the reference to the removed row is
//      cleared instead ("unlink"), or it needs a person if that column is
//      required.
//   4. BACKUP, THEN DELETE (--apply only).
//        a. a JSON backup of every row that will be deleted or changed, every
//           column, in the rtp-backup-all/2 layout (scripts/_lib/backupFormat),
//           so scripts/restore-content-program.ts can replay it;
//        b. a whole-hub backup through scripts/backup-all.ts (or
//           --full-backup=<file> taken in the last 6 hours);
//        c. the removed-clients record (AppSetting "clients:removed",
//           src/lib/removedClients.ts) so the Aryeo syncs do not re-create
//           them — DEPLOY THAT CODE FIRST;
//        d. per group of linked clients, ONE transaction: the moves/unlinks,
//           then the deletes children-first by the database's own foreign keys
//           (read from pg_constraint, not assumed), each count checked, then a
//           re-scan proving nothing still points at the removed clients. Any
//           mismatch rolls that group back whole.
//   Log tables (AuditLog, ErrorEvent, CronRun, WebhookEvent, UsageEvent) are
//   kept: they are history, nothing displays them as a client's.
//
// Nothing is sent; no Aryeo, Dropbox, Gmail or OpenPhone call is made.
//
// RUN (Node 20; from the repo root):
//   Dry run (default; the connection is read-only, proven by a refused write):
//     NODE_OPTIONS=--conditions=react-server npx tsx --require ./scripts/_drill/_drill-preload.cjs --env-file=.env scripts/_live/oct23-remove-test-clients.ts
//   Dry run that also writes the JSON backup file (still read-only):
//     ... scripts/_live/oct23-remove-test-clients.ts --write-backup
//   Apply:
//     ... scripts/_live/oct23-remove-test-clients.ts --apply [--accept-unplaced] [--full-backup=<file>] [--backup-dir=<dir>]
//   Undo: npx tsx scripts/restore-content-program.ts <backup.json> --apply --target-production --incident "undo oct23 removal"
//         then remove the entries from AppSetting "clients:removed".
// ---------------------------------------------------------------------------
export {};

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes("--apply");
const ACCEPT_UNPLACED = ARGS.includes("--accept-unplaced");
const WRITE_BACKUP = ARGS.includes("--write-backup") || APPLY;
const argVal = (k: string): string | null => ARGS.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
// --owner-approved=<clientId>[,…]: Jordan approved removing these despite the
// real-business evidence (Oct 23: "Can remove Jordan Spackman shoot records.
// I'm not a client."). The evidence is still printed.
const OWNER_APPROVED = new Set((argVal("owner-approved") ?? "").split(",").filter(Boolean));
const FULL_BACKUP = argVal("full-backup");
const BACKUP_DIR = argVal("backup-dir") ?? "/private/tmp/claude-501/-Users-jordanspackman-Realtour-Pilot-POT-Dashboard/8965ab24-8365-44d5-af17-c1b185a8a42d/scratchpad/backups";
const REPO = path.resolve(__dirname, "../..");

if (!APPLY) {
  // A dry run cannot write, whatever the code below does.
  const u = process.env.DATABASE_URL ?? "";
  if (!u) { console.error("DATABASE_URL is not set (pass --env-file=.env)"); process.exit(2); }
  process.env.DATABASE_URL = u + (u.includes("?") ? "&" : "?") + "options=-c%20default_transaction_read_only%3Don";
}

type Row = Record<string, unknown>;
type Field = { name: string; kind: string; type: string; isList: boolean; isRequired: boolean; isId: boolean; relationFromFields?: readonly string[] | null; relationName?: string | null };
type Model = { name: string; dbName?: string | null; fields: readonly Field[]; primaryKey?: { fields: readonly string[] } | null };
type RefField = { name: string; list: boolean; required: boolean };
type Decision =
  | { kind: "target" }
  | { kind: "delete"; why: string }
  | { kind: "move"; to: string; toName: string; why: string; set: Row }
  | { kind: "ownerOnly"; why: string; set: Row }
  | { kind: "unlink"; why: string; set: Row }
  | { kind: "unplaced"; why: string; fallback: Row | "delete" }
  | { kind: "keepLog" };

const KEEP_LOGS = new Set(["AuditLog", "ErrorEvent", "CronRun", "WebhookEvent", "UsageEvent"]);
const RESCUE = new Set(["CommLog", "Contact", "ClientAsk", "SmartTask"]);
const GENERIC_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com", "me.com", "comcast.net", "verizon.net", "live.com", "msn.com", "wixforms.com"]);
const OPERATIONAL_TASK_SOURCES = new Set(["aryeo", "system", "content_program", "revision", "creative_review", "portal_system"]);
const MESSAGE_TASK_SOURCES = new Set(["gmail", "openphone", "openphone-call", "slack", "email", "portal"]);

const one = (s: unknown, n = 110): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const k = (model: string, id: string) => `${model}:${id}`;
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

async function main() {
  const { Prisma } = await import("@prisma/client");
  const { prisma } = await import("@/lib/prisma");
  const { syntheticClientRows } = await import("@/lib/syntheticClients");
  const T = await import("@/lib/testClients");
  const { OWNER_PERSONAL_ADDRESSES, forwardedSenderAddress, isForward } = await import("@/lib/mailMatch");
  const { REMOVED_CLIENTS_KEY, mergeRemovedClients, parseRemovedClients } = await import("@/lib/removedClients");
  const BF = await import("../_lib/backupFormat");
  const db = prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<Row[]>; count: (a: unknown) => Promise<number> }>;

  console.log(`${APPLY ? "APPLY" : "DRY RUN (read-only connection)"} — oct23 remove test clients — ${new Date().toISOString()}\n`);
  if (!APPLY) {
    try {
      await prisma.$executeRawUnsafe(`UPDATE "Client" SET "name" = "name" WHERE false`);
      throw new Error("GUARD FAILED: the dry-run connection accepted a write");
    } catch (e) {
      if (!/25006|read-only/i.test(String(e))) throw e;
      console.log("read-only connection proven (SQLSTATE 25006; the prisma:error above is that refusal)\n");
    }
  }

  // ---- the datamodel ------------------------------------------------------
  const models = Prisma.dmmf.datamodel.models as unknown as Model[];
  const byName = new Map(models.map((m) => [m.name, m]));
  let schemaText = "";
  try { schemaText = fs.readFileSync(path.join(REPO, "prisma/schema.prisma"), "utf8"); } catch { /* generated client is the authority */ }
  const plain = schemaText ? BF.plainRefs(schemaText) : new Map<string, Map<string, string>>();
  const fkFieldsOf = (m: Model) => new Set(m.fields.flatMap((f) => (f.kind === "object" && f.relationFromFields?.length ? [...f.relationFromFields] : [])));
  const refFields = new Map<string, RefField[]>();
  for (const m of models) {
    const fk = fkFieldsOf(m);
    const out: RefField[] = [];
    for (const f of m.fields) {
      if (f.kind !== "scalar" || f.type !== "String" || f.isId) continue;
      if (fk.has(f.name) || plain.get(m.name)?.has(f.name) || /(Id|Ids|Ref)$/.test(f.name)) out.push({ name: f.name, list: f.isList, required: f.isRequired });
    }
    if (out.length) refFields.set(m.name, out);
  }
  const idOf = (m: string): string => { const f = byName.get(m)!.fields.find((x) => x.isId); return f ? f.name : "__composite__"; };
  const clientFieldsOf = (m: string) => (refFields.get(m) ?? []).filter((f) => !f.list && (f.name === "clientId" || (/ClientId$/.test(f.name) && !/ClientUserId$/.test(f.name)))).map((f) => f.name);
  const projectFieldsOf = (m: string) => (refFields.get(m) ?? []).filter((f) => !f.list && (f.name === "projectId" || /ProjectId$/.test(f.name))).map((f) => f.name);
  const enrollmentFieldsOf = (m: string) => (refFields.get(m) ?? []).filter((f) => !f.list && f.name === "enrollmentId").map((f) => f.name);

  // The database's own foreign keys and what each does on delete.
  const fkRows = await prisma.$queryRawUnsafe<{ child: string; col: string; parent: string; del: string; nullable: boolean }[]>(`
    SELECT cl.relname AS child, att.attname AS col, pcl.relname AS parent, con.confdeltype::text AS del, NOT att.attnotnull AS nullable
    FROM pg_constraint con
    JOIN pg_class cl ON cl.oid = con.conrelid
    JOIN pg_class pcl ON pcl.oid = con.confrelid
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
    WHERE con.contype = 'f' AND cl.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`);
  const tableToModel = new Map(models.map((m) => [m.dbName || m.name, m.name]));
  const DEL = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" } as Record<string, string>;
  const liveFks = fkRows.map((r) => ({ child: tableToModel.get(r.child) ?? r.child, col: r.col, parent: tableToModel.get(r.parent) ?? r.parent, onDelete: DEL[r.del] ?? r.del, nullable: r.nullable }));
  // A model the generated client knows but this database has no table for
  // (a schema change not yet pushed) holds no rows: skipped, and said so.
  const present = new Set((await prisma.$queryRawUnsafe<{ t: string }[]>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema()`)).map((r) => r.t));
  const missingTables = models.filter((m) => !present.has(m.dbName || m.name)).map((m) => m.name);
  for (const m of missingTables) refFields.delete(m);
  if (missingTables.length) console.log(`WARNING: no table in this database for ${missingTables.join(", ")} (the generated client is ahead of it); skipped\n`);

  // ---- targets ------------------------------------------------------------
  const jordanRows = (await prisma.client.findMany({ where: { name: { contains: "spackman", mode: "insensitive" } }, select: { id: true, name: true } }));
  const jordanTargets = jordanRows.filter((c) => /^\s*jordan\s+spackman\b/i.test(c.name));
  const otherSpackman = jordanRows.filter((c) => !jordanTargets.some((t) => t.id === c.id));
  const synthetic = await syntheticClientRows();
  const targetIds = [...new Set([...jordanTargets.map((c) => c.id), ...synthetic.map((c) => c.id)])];
  const targets = await prisma.client.findMany({
    where: { id: { in: targetIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, email: true, backupEmail: true, phone: true, company: true, aryeoCustomerId: true, parentClientId: true, createdAt: true, segment: true, lifetimeSpendCents: true, transactionCount: true, socialClient: true, socialPlan: true },
  });
  const targetSet = new Set(targetIds);
  const targetName = new Map(targets.map((t) => [t.id, t.name]));
  const why = (id: string) => [jordanTargets.some((c) => c.id === id) ? "(a) Jordan Spackman" : null, synthetic.some((c) => c.id === id) ? "(b) synthetic" : null].filter(Boolean).join(" + ");
  console.log(`TARGETS (${targets.length})`);
  for (const t of targets) {
    console.log(`  · ${t.id}  "${t.name}"  ${why(t.id)}  <${t.email ?? "-"}>${t.backupEmail ? ` backup <${t.backupEmail}>` : ""}  ${t.phone ?? ""}  aryeo ${t.aryeoCustomerId ?? "-"}  created ${t.createdAt.toISOString().slice(0, 10)}${T.isNeverSyntheticClientId(t.id) ? "  [on NEVER_SYNTHETIC_CLIENT_IDS]" : ""}`);
  }
  if (otherSpackman.length) console.log(`  not targeted (Spackman, not "Jordan Spackman"): ${otherSpackman.map((c) => `${c.id} "${c.name}"`).join(", ")}`);
  console.log(`  synthetic rule: syntheticClientRows() = isSyntheticClientRow (${synthetic.length} rows: ${synthetic.map((c) => `"${c.name}"`).join(", ")})`);

  // ---- STOP CONDITIONS ------------------------------------------------------
  const projects = await prisma.project.findMany({
    where: { clientId: { in: targetIds } },
    select: { id: true, clientId: true, title: true, status: true, source: true, aryeoOrderId: true, price: true, paymentStatus: true, balanceAmount: true, paidMarkedAt: true, orderedAt: true, shootDate: true, deliveredAt: true, arRemovedAt: true, arRemovedNote: true, photographerId: true, _count: { select: { uploads: true } } },
  });
  const stripeByProject = await prisma.stripeTransaction.findMany({ where: { projectId: { in: projects.map((p) => p.id) } }, select: { id: true, type: true, gross: true, projectId: true, createdAt: true } });
  const enrollments = await prisma.contentEnrollment.findMany({ where: { clientId: { in: targetIds } }, select: { id: true, clientId: true, package: true, status: true, billingType: true, billingRate: true, portalToken: true } });
  const entitlements = await prisma.programEntitlement.findMany({ where: { clientId: { in: targetIds } } }).catch(() => [] as Row[]);
  const signups = await prisma.programSignup.findMany({ where: { clientId: { in: targetIds } } });
  const leftAlone = new Map<string, string[]>();
  const consideredNotReal = new Map<string, string[]>();
  console.log(`\nSTOP CONDITIONS (real business is left alone)`);
  for (const t of targets) {
    const ev: string[] = [];
    const notReal: string[] = [];
    const ps = projects.filter((p) => p.clientId === t.id);
    for (const p of ps) {
      const money = `$${p.price ?? 0} ${p.paymentStatus ?? "-"} balance $${((p.balanceAmount ?? 0) / 100).toFixed(2)}`;
      const ownerMarkedTest = /\btest/i.test(p.arRemovedNote ?? "") || T.isTestClientName(p.title);
      const paid = (p.price ?? 0) > 0 && (/^(PAID|PARTIALLY_PAID)$/i.test(p.paymentStatus ?? "") || (p.balanceAmount != null && p.balanceAmount < Math.round((p.price ?? 0) * 100)));
      if (paid || p.paidMarkedAt) ev.push(`paid Aryeo order: "${p.title}" order ${p.aryeoOrderId} ${money}${p.paidMarkedAt ? " (owner marked paid)" : ""}`);
      const delivered = p.status === "DELIVERED" || (!!p.deliveredAt && p.status !== "CANCELLED");
      const work = [p.photographerId ? "a creative assigned" : null, p.shootDate ? `shot ${p.shootDate.toISOString().slice(0, 10)}` : null, p._count.uploads ? `${p._count.uploads} upload(s)` : null, (p.price ?? 0) > 0 ? `priced $${p.price}` : null].filter(Boolean);
      if (delivered && p.source === "ARYEO" && !ownerMarkedTest && work.length) ev.push(`delivered real job: "${p.title}" order ${p.aryeoOrderId} ordered ${p.orderedAt?.toISOString().slice(0, 10) ?? "?"}, delivered ${p.deliveredAt?.toISOString().slice(0, 10) ?? "?"}, ${work.join(", ")}, ${money}`);
      else if (delivered) notReal.push(`"${p.title}" (${p.status}, ${p.source}${p.aryeoOrderId ? ` order ${p.aryeoOrderId}` : ""}, ${money}): ${ownerMarkedTest ? `owner marked it test${p.arRemovedNote ? ` ("${p.arRemovedNote}")` : ""}` : "no creative, no shoot date, no files, no price"}`);
    }
    for (const s of stripeByProject.filter((s) => ps.some((p) => p.id === s.projectId))) ev.push(`Stripe ${s.type} ${s.id} $${s.gross} ${s.createdAt.toISOString().slice(0, 10)}`);
    const qbo = await prisma.qboTransaction.findMany({ where: { customerName: { equals: t.name, mode: "insensitive" } }, select: { id: true, type: true, amount: true, txnDate: true } });
    for (const q of qbo) ev.push(`QuickBooks ${q.type} ${q.id} $${q.amount} ${q.txnDate.toISOString().slice(0, 10)} (customer "${t.name}")`);
    const stripeName = await prisma.stripeTransaction.findMany({ where: { customerName: { equals: t.name, mode: "insensitive" } }, select: { id: true, type: true, gross: true } });
    for (const s of stripeName) ev.push(`Stripe ${s.type} ${s.id} $${s.gross} (customer "${t.name}")`);
    for (const e of enrollments.filter((e) => e.clientId === t.id)) {
      if (e.billingType || (e.billingRate ?? 0) > 0) ev.push(`paying content enrollment ${e.id} ${e.package} ${e.billingType ?? ""} $${e.billingRate ?? 0}`);
    }
    for (const e of entitlements as Row[]) if (e.clientId === t.id && /paid|stripe|invoice/i.test(JSON.stringify(e))) ev.push(`program entitlement ${String(e.id)} mentions payment`);
    for (const s of signups as Row[]) if (s.clientId === t.id) ev.push(`website program signup ${String(s.id)} (Stripe checkout)`);
    if (ev.length && OWNER_APPROVED.has(t.id)) ev.push("OWNER APPROVED its removal (--owner-approved)");
    if (ev.length && !OWNER_APPROVED.has(t.id)) leftAlone.set(t.id, ev);
    if (notReal.length) consideredNotReal.set(t.id, notReal);
    console.log(`  · "${t.name}" ${t.id}: ${ev.length && !OWNER_APPROVED.has(t.id) ? "REAL BUSINESS — LEFT ALONE" : ev.length ? "real business evidence, OWNER APPROVED — will be removed" : "no real business found — will be removed"}`);
    for (const e of ev) console.log(`      evidence: ${e}`);
    for (const n of notReal) console.log(`      considered, not real: ${n}`);
  }
  const qboVenmo = await prisma.qboTransaction.count({ where: { OR: [{ memo: { contains: "spackman", mode: "insensitive" } }, { customerName: { contains: "spackman", mode: "insensitive" } }] } });
  console.log(`  (QuickBooks rows naming Spackman in the memo or customer: ${qboVenmo}. They carry no client or project id, so removing a client does not touch them; they are Jordan's own Venmo deposits, see reference-account-0942.)`);
  const removeIds = targetIds.filter((id) => !leftAlone.has(id));
  const removeSet = new Set(removeIds);

  // ---- lookups for owners -------------------------------------------------
  const projectClient = new Map<string, string>();
  const enrollmentClient = new Map<string, string>();
  const ensureOwners = async (projectIds: string[], enrollmentIds: string[]) => {
    const p = projectIds.filter((id) => !projectClient.has(id));
    for (let i = 0; i < p.length; i += 1000) for (const r of await prisma.project.findMany({ where: { id: { in: p.slice(i, i + 1000) } }, select: { id: true, clientId: true } })) projectClient.set(r.id, r.clientId);
    const e = enrollmentIds.filter((id) => !enrollmentClient.has(id));
    for (let i = 0; i < e.length; i += 1000) for (const r of await prisma.contentEnrollment.findMany({ where: { id: { in: e.slice(i, i + 1000) } }, select: { id: true, clientId: true } })) enrollmentClient.set(r.id, r.clientId);
  };
  const ownersOf = (model: string, row: Row): Set<string> => {
    const out = new Set<string>();
    if (model === "Client") { out.add(String(row.id)); return out; }
    for (const f of clientFieldsOf(model)) if (typeof row[f] === "string") out.add(row[f] as string);
    for (const f of projectFieldsOf(model)) { const c = typeof row[f] === "string" ? projectClient.get(row[f] as string) : undefined; if (c) out.add(c); }
    for (const f of enrollmentFieldsOf(model)) { const c = typeof row[f] === "string" ? enrollmentClient.get(row[f] as string) : undefined; if (c) out.add(c); }
    return out;
  };

  // ---- the walk -------------------------------------------------------------
  type Walk = {
    rows: Map<string, { model: string; row: Row }>;
    decision: Map<string, Decision>;
    prov: Map<string, Set<string>>; // row key → seed clients it descends from
    via: Map<string, string[]>; // row key → "Model.field" it was reached through
  };
  const parallel = async <A, R>(items: A[], n: number, fn: (a: A) => Promise<R>): Promise<R[]> => {
    const out: R[] = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const j = i++; out[j] = await fn(items[j]); } }));
    return out;
  };

  /**
   * Breadth-first from the seed clients. `decide` returns the decision for a
   * newly reached row; only "delete" (and the seeds) propagate further.
   * `hold` rows (the rescue models) are collected without a decision and
   * handed back, so they can be decided together, then fed back in.
   */
  async function walk(seeds: string[], decide: ((model: string, row: Row, matched: string[], w: Walk) => Decision | "hold") | null): Promise<{ w: Walk; held: string[] }> {
    const w: Walk = { rows: new Map(), decision: new Map(), prov: new Map(), via: new Map() };
    const seedRows = await prisma.client.findMany({ where: { id: { in: seeds } } });
    for (const r of seedRows) {
      const key = k("Client", r.id);
      w.rows.set(key, { model: "Client", row: r as unknown as Row });
      w.decision.set(key, { kind: "target" });
      w.prov.set(key, new Set([r.id]));
    }
    const held: string[] = [];
    let frontier = new Map<string, Set<string>>(seeds.map((id) => [id, new Set([id])]));
    const idModel = new Map<string, string>(seeds.map((id) => [id, "Client"]));
    const step = async (front: Map<string, Set<string>>) => {
      const ids = [...front.keys()];
      const next = new Map<string, Set<string>>();
      const results = await parallel([...refFields.entries()], 6, async ([model, fields]) => {
        const found: Row[] = [];
        for (let i = 0; i < ids.length; i += 800) {
          const chunk = ids.slice(i, i + 800);
          const where = { OR: fields.map((f) => (f.list ? { [f.name]: { hasSome: chunk } } : { [f.name]: { in: chunk } })) };
          found.push(...(await db[BF.delegateName(model)].findMany({ where })));
        }
        return { model, fields, found };
      });
      // owners need the projects/enrollments these rows name
      const pIds: string[] = [], eIds: string[] = [];
      for (const { model, found } of results) for (const r of found) {
        for (const f of projectFieldsOf(model)) if (typeof r[f] === "string") pIds.push(r[f] as string);
        for (const f of enrollmentFieldsOf(model)) if (typeof r[f] === "string") eIds.push(r[f] as string);
      }
      await ensureOwners([...new Set(pIds)], [...new Set(eIds)]);
      for (const { model, fields, found } of results) {
        const idf = idOf(model);
        for (const r of found) {
          const rid = idf === "__composite__" ? BF.idKeyOf(r, [...(byName.get(model)!.primaryKey?.fields ?? [])]) : String(r[idf]);
          const key = k(model, rid);
          const matched: string[] = [];
          const prov = new Set<string>();
          for (const f of fields) {
            const vals = f.list ? ((r[f.name] as string[] | null) ?? []) : [r[f.name] as string | null];
            for (const v of vals) if (v && front.has(v)) { matched.push(`${f.name}→${idModel.get(v) ?? "?"}:${v}`); for (const c of front.get(v)!) prov.add(c); }
          }
          if (!matched.length) continue;
          const known = w.decision.get(key);
          if (known) {
            const p = w.prov.get(key)!;
            const before = p.size;
            for (const c of prov) p.add(c);
            const v = w.via.get(key);
            if (v) for (const m of matched) if (!v.includes(m)) v.push(m);
            if (p.size > before && (known.kind === "delete" || known.kind === "target")) next.set(rid, new Set(p));
            continue;
          }
          if (held.includes(key)) { for (const c of prov) w.prov.get(key)!.add(c); continue; }
          w.rows.set(key, { model, row: r });
          w.prov.set(key, prov);
          w.via.set(key, matched);
          idModel.set(rid, model);
          const d = decide ? decide(model, r, matched, w) : (KEEP_LOGS.has(model) ? { kind: "keepLog" as const } : { kind: "delete" as const, why: "inventory" });
          if (d === "hold") { held.push(key); continue; }
          w.decision.set(key, d);
          if (d.kind === "delete") next.set(rid, prov);
        }
      }
      return next;
    };
    while (frontier.size) frontier = await step(frontier);
    // resume: the caller decides held rows, then calls feed() with the ones to delete
    (w as Walk & { feed?: (keys: string[]) => Promise<void> }).feed = async (keys: string[]) => {
      let f = new Map<string, Set<string>>();
      for (const key of keys) { const { model, row } = w.rows.get(key)!; const id = String(row[idOf(model)]); idModel.set(id, model); f.set(id, w.prov.get(key)!); }
      while (f.size) f = await step(f);
    };
    return { w, held };
  }

  // ---- 1. INVENTORY (all targets, every row that points at them) -----------
  console.log(`\nINVENTORY — every row that points at a target, directly or through its rows (all ${targets.length} targets)`);
  const inv = await walk(targetIds, (model, row, matched, w) => {
    const owners = ownersOf(model, row);
    const outside = [...owners].filter((o) => !targetSet.has(o));
    if (model === "Client" && !targetSet.has(String(row.id))) return { kind: "unlink", why: "another client", set: {} };
    if (KEEP_LOGS.has(model)) return { kind: "keepLog" };
    if (outside.length) return { kind: "unlink", why: `also belongs to ${outside.join(", ")}`, set: {} };
    void matched; void w;
    return { kind: "delete", why: "inventory" };
  });
  const SAMPLE_FIELDS = ["title", "subject", "name", "summary", "text", "fileName", "label", "body"];
  const sampleOf = (model: string, row: Row): string | null => {
    for (const f of SAMPLE_FIELDS) if (typeof row[f] === "string" && (row[f] as string).trim()) return one(row[f], 70);
    void model;
    return null;
  };
  for (const t of targets) {
    const per = new Map<string, Row[]>();
    const cross: string[] = [];
    for (const [key, d] of inv.w.decision) {
      if (!inv.w.prov.get(key)?.has(t.id)) continue;
      const { model, row } = inv.w.rows.get(key)!;
      if (d.kind === "target") continue;
      if (d.kind === "unlink") { cross.push(`${model} ${String(row[idOf(model)] ?? key)} (${d.why}) via ${inv.w.via.get(key)?.join(", ")}`); continue; }
      const label = d.kind === "keepLog" ? `${model} (log, kept)` : model;
      if (!per.has(label)) per.set(label, []);
      per.get(label)!.push(row);
    }
    const total = [...per.values()].reduce((a, b) => a + b.length, 0);
    console.log(`\n  "${t.name}" ${t.id} — ${leftAlone.has(t.id) ? "LEFT ALONE (real business)" : "TO REMOVE"} — ${total} row(s) in ${per.size} model(s)${cross.length ? `, ${cross.length} cross-linked` : ""}`);
    for (const [label, rows] of [...per].sort((a, b) => b[1].length - a[1].length)) {
      const samples = [...new Set(rows.map((r) => sampleOf(label, r)).filter(Boolean))].slice(0, 3);
      console.log(`      ${label.padEnd(28)} ${String(rows.length).padStart(4)}${samples.length ? `   e.g. ${samples.map((s) => `"${s}"`).join(" · ")}` : ""}`);
    }
    for (const c of cross.slice(0, 12)) console.log(`      cross-linked: ${c}`);
    if (cross.length > 12) console.log(`      … ${cross.length - 12} more cross-linked`);
  }

  // Plain clientId / projectId columns with no declared relation.
  const plainCols: string[] = [];
  for (const m of models) {
    const fk = fkFieldsOf(m);
    for (const f of [...clientFieldsOf(m.name), ...projectFieldsOf(m.name), ...enrollmentFieldsOf(m.name)]) {
      if (fk.has(f)) continue;
      plainCols.push(`${m.name}.${f}${plain.get(m.name)?.has(f) ? "" : "*"}`);
    }
  }
  console.log(`\n  PLAIN clientId / projectId / enrollmentId COLUMNS (no foreign key; * = not even a "// -> Model" note) — ${plainCols.length}:`);
  for (let i = 0; i < plainCols.length; i += 6) console.log(`      ${plainCols.slice(i, i + 6).join("  ")}`);
  console.log(`  DATABASE FOREIGN KEYS INTO Client / Project (as Postgres has them, not as assumed):`);
  for (const f of liveFks.filter((f) => f.parent === "Client" || f.parent === "Project")) console.log(`      ${f.child}.${f.col} → ${f.parent}  ON DELETE ${f.onDelete}${f.nullable ? "" : " (required)"}`);

  if (!removeIds.length) {
    console.log("\nNothing to remove: every target is real business.");
    process.exit(0);
  }

  // ---- 2. RESCUE context ----------------------------------------------------
  const staffEmails = new Set<string>(OWNER_PERSONAL_ADDRESSES.map(lc));
  const staffNames = new Set<string>(["jordan spackman", "us"]);
  for (const m of await prisma.teamMember.findMany({ select: { email: true, name: true } })) { if (m.email) staffEmails.add(lc(m.email)); if (m.name) staffNames.add(lc(m.name)); }
  for (const u of await prisma.appUser.findMany({ select: { email: true } })) if (u.email) staffEmails.add(lc(u.email));
  const isStaffAddr = (a: string) => { const x = lc(a); return x.endsWith("@realtourpilot.com") || x.endsWith("@realtorpilot.com") || staffEmails.has(x); };
  const isOwnerAddr = (a: string) => { const x = lc(a); return (OWNER_PERSONAL_ADDRESSES as readonly string[]).includes(x) || x === "info@realtorpilot.com"; };
  // Only the SYNTHETIC names mark test traffic: "Jordan Spackman" is on every
  // signature Jordan writes, so his real name proves nothing.
  const testNames = [...targets.filter((t) => T.isSyntheticClientRow(t)).map((t) => t.name), "Bobby TEST", "Cara TEST", "John Doe"].map(lc);
  const mentionsTest = (s: string) => { const x = lc(s); return testNames.some((n) => n && x.includes(n)) || /\bTEST\b/.test(s); };

  const others = await prisma.client.findMany({ where: { id: { notIn: targetIds } }, select: { id: true, name: true, email: true, backupEmail: true, parentClientId: true } });
  const nameOf = new Map(others.map((c) => [c.id, c.name]));
  const fold = (id: string) => others.find((c) => c.id === id)?.parentClientId ?? id;
  const byEmail = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, key: string, id: string) => { if (!key) return; if (!m.has(key)) m.set(key, new Set()); m.get(key)!.add(fold(id)); };
  for (const c of others) { add(byEmail, lc(c.email), c.id); add(byEmail, lc(c.backupEmail), c.id); }
  const emailOwner = new Map<string, string>();
  for (const c of others) for (const e of [c.email, c.backupEmail]) if (e && !emailOwner.has(lc(e))) emailOwner.set(lc(e), c.name);
  const contactByEmail = new Map<string, Set<string>>();
  for (const x of await prisma.contact.findMany({ where: { clientId: { notIn: targetIds, not: null }, email: { not: null } }, select: { email: true, clientId: true } })) add(contactByEmail, lc(x.email), x.clientId!);
  const aliasByEmail = new Map<string, Set<string>>();
  for (const a of await prisma.clientEmailAlias.findMany({ where: { active: true, clientId: { notIn: targetIds } }, select: { email: true, clientId: true } })) add(aliasByEmail, lc(a.email), a.clientId);
  const normName = (s: string) => lc(s).replace(/[^a-z\s'-]/g, " ").replace(/\s+/g, " ").trim();
  const clientsByName = new Map<string, Set<string>>();
  for (const c of others) { const n = normName(c.name); if (n.split(" ").length >= 2) add(clientsByName, n, c.id); }
  const byDomain = new Map<string, Set<string>>();
  for (const c of others) for (const e of [c.email, c.backupEmail]) { const d = lc(e).split("@")[1]; if (d && !GENERIC_DOMAINS.has(d) && !isStaffAddr(lc(e))) add(byDomain, d, c.id); }
  const otherProjects = await prisma.project.findMany({ where: { clientId: { notIn: targetIds } }, select: { id: true, title: true, clientId: true } });
  const townWords = new Set<string>();
  for (const p of otherProjects) for (const part of p.title.split(",").slice(1)) { const t = part.trim().toLowerCase(); if (t) townWords.add(t); }

  type Placement = { clientId: string; projectId?: string; why: string } | { ambiguous: string } | null;
  const placeByEmail = (emails: string[]): Placement => {
    for (const e of emails) {
      for (const [label, m] of [["client email", byEmail], ["contact", contactByEmail], ["email alias", aliasByEmail]] as const) {
        const hit = m.get(e);
        if (hit?.size === 1) {
          const id = [...hit][0];
          const owner = emailOwner.get(e);
          return { clientId: id, why: `${label} ${e}${owner && owner !== nameOf.get(id) ? ` (${owner}, folded onto ${nameOf.get(id)}'s account as the hub's comms routing does)` : ""}` };
        }
        if (hit && hit.size > 1) return { ambiguous: `${e} is on ${hit.size} clients (${[...hit].map((x) => nameOf.get(x)).join(", ")})` };
      }
    }
    return null;
  };
  const placeByName = (names: string[], text: string): Placement => {
    const exact = names.map(normName).filter((n) => n.split(" ").length >= 2);
    for (const n of exact) { const hit = clientsByName.get(n); if (hit?.size === 1) return { clientId: [...hit][0], why: `the name "${n}"` }; if (hit && hit.size > 1) return { ambiguous: `"${n}" names ${hit.size} clients` }; }
    if (text) {
      const t = ` ${normName(text)} `;
      const hits = new Set<string>();
      for (const [n, ids] of clientsByName) if (n.length >= 7 && t.includes(` ${n} `)) for (const id of ids) hits.add(id);
      if (hits.size === 1) { const id = [...hits][0]; return { clientId: id, why: `the text names ${nameOf.get(id)}` }; }
      if (hits.size > 1) return { ambiguous: `the text names ${[...hits].map((x) => nameOf.get(x)).join(", ")}` };
    }
    return null;
  };
  const placeByDomain = (emails: string[]): Placement => {
    for (const e of emails) { const d = e.split("@")[1]; if (!d || GENERIC_DOMAINS.has(d)) continue; const hit = byDomain.get(d); if (hit?.size === 1) return { clientId: [...hit][0], why: `company domain ${d}` }; if (hit && hit.size > 1) return { ambiguous: `domain ${d} is on ${hit.size} clients` }; }
    return null;
  };
  const placeByJob = (text: string): Placement => {
    const hits = new Map<string, { projectId: string; title: string }>();
    for (const m of text.matchAll(/\b(\d{1,5})\s+([A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]+)?)/g)) {
      const key = `${m[1]} ${m[2].split(/\s+/)[0]}`.toLowerCase();
      for (const p of otherProjects) if (p.title.toLowerCase().startsWith(key)) hits.set(fold(p.clientId), { projectId: p.id, title: p.title });
    }
    for (const m of text.matchAll(/\b([A-Z][a-z]{2,} [A-Z][a-z]{2,})\s+(?:Zillow|listing|photos?|shoot|video|Showcase)/g)) {
      for (const p of otherProjects) if (p.title.toLowerCase().includes(m[1].toLowerCase())) hits.set(fold(p.clientId), { projectId: p.id, title: p.title });
    }
    // A street name on its own ("Couple Changes for Green Pond"): a two-word
    // phrase found in the STREET part of exactly one client's job title, and in
    // no job's town part (so "West Chester" never names a job).
    if (!hits.size) {
      for (const m of text.matchAll(/\b([A-Z][a-z]{2,} [A-Z][a-z]{2,})\b/g)) {
        const phrase = m[1].toLowerCase();
        if (townWords.has(phrase)) continue;
        for (const p of otherProjects) if (p.title.split(",")[0].toLowerCase().includes(phrase)) hits.set(fold(p.clientId), { projectId: p.id, title: p.title });
      }
    }
    if (hits.size === 1) { const [cid, p] = [...hits][0]; return { clientId: cid, projectId: p.projectId, why: `the job it names ("${p.title}")` }; }
    if (hits.size > 1) return { ambiguous: `the text names jobs of ${[...hits.keys()].map((x) => nameOf.get(x)).join(", ")}` };
    return null;
  };
  const tiers = (o: { emails: string[]; names: string[]; text?: string; job?: string }): Placement => {
    const emails = [...new Set(o.emails.map(lc).filter((e) => e.includes("@") && !isStaffAddr(e)))];
    return placeByEmail(emails) ?? placeByName(o.names, o.text ?? "") ?? placeByDomain(emails) ?? (o.job ? placeByJob(o.job) : null);
  };
  const emailsIn = (s: string) => [...new Set((s.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).map(lc))];
  // The outside person a staff forward carries: the live rule first
  // (mailMatch.forwardedSenderAddress: the first non-staff "From:" line), then
  // the same read on a body whose line breaks were lost ("… --------- From:
  // Adam Feine <adam@…> Date: …" on one line), then the first non-staff
  // "<address> wrote:" — a forward of Jordan's own reply quotes the client
  // that way and nowhere else.
  const forwardedFrom = (subject: string, body: string): string | null => {
    const live = forwardedSenderAddress(subject, body, isStaffAddr);
    if (live) return lc(live);
    // The fallbacks only for a mail Jordan actually forwarded ("Fwd:" subject):
    // a reply ("Re:") whose quoted history holds a forward banner is his own words.
    if (!/^\s*(?:fwd?|fw)\s*:/i.test(subject) || !isForward(subject, body)) return null;
    for (const m of body.matchAll(/From:\*?\s*[^<\n]{0,80}<([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>/gi)) if (!isStaffAddr(m[1])) return lc(m[1]);
    for (const m of body.matchAll(/<([A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>\s*wrote:/gi)) if (!isStaffAddr(m[1])) return lc(m[1]);
    return null;
  };
  const fwdDisplay = (body: string, addr: string) => { const m = new RegExp(`(?:From:\\*?|\\d{1,2}:\\d{2} [AP]M)\\s*([^<\\n]{1,60}?)\\s*<${addr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`, "i").exec(body); return m ? m[1].replace(/["*]/g, "").trim() : ""; };
  const threadOf = (ext: string) => /^gmail-sent-([0-9a-f]+)-/.exec(ext)?.[1] ?? /^gmail-[^:]+:([0-9a-f]+)$/.exec(ext)?.[1] ?? null;

  // A Gmail thread filed under exactly one real client elsewhere answers "whose thread is this reply in?".
  const threadClient = async (thread: string): Promise<string | null> => {
    const [logs, tasks] = await Promise.all([
      prisma.commLog.findMany({ where: { externalId: { contains: thread }, clientId: { notIn: targetIds, not: null } }, select: { clientId: true } }),
      prisma.smartTask.findMany({ where: { sourceDetail: { contains: thread }, clientId: { notIn: targetIds, not: null } }, select: { clientId: true } }),
    ]);
    const ids = new Set([...logs, ...tasks].map((r) => fold(r.clientId!)));
    return ids.size === 1 ? [...ids][0] : null;
  };

  // ---- 3. THE PLAN (removable targets only) ---------------------------------
  const isSeedSynthetic = (id: string) => T.isSyntheticClientRow({ id, name: targetName.get(id) });
  const decideGeneric = (model: string, row: Row, matched: string[]): Decision | "hold" => {
    if (model === "Client") {
      if (removeSet.has(String(row.id))) return { kind: "target" };
      const set: Row = {};
      for (const m of matched) set[m.split("→")[0]] = null;
      return { kind: "unlink", why: `client "${String(row.name)}" pointed at a removed client (${matched.join(", ")})`, set };
    }
    if (KEEP_LOGS.has(model)) return { kind: "keepLog" };
    const owners = ownersOf(model, row);
    const outside = [...owners].filter((o) => !removeSet.has(o));
    if (outside.length) {
      const set: Row = {};
      const fields = refFields.get(model)!;
      let required = false;
      for (const m of matched) {
        const fname = m.split("→")[0];
        const f = fields.find((x) => x.name === fname)!;
        const removedId = m.split(":").slice(1).join(":");
        if (f.list) set[fname] = ((row[fname] as string[]) ?? []).filter((v) => v !== removedId);
        else if (f.required) required = true;
        else set[fname] = null;
      }
      const owner = outside.map((o) => `${nameOf.get(o) ?? targetName.get(o) ?? "?"} (${o})`).join(", ");
      if (required) return { kind: "unplaced", why: `belongs to ${owner} but a REQUIRED column points at a removed row (${matched.join(", ")})`, fallback: "delete" };
      return { kind: "unlink", why: `belongs to ${owner}; clear ${Object.keys(set).join(", ")}`, set };
    }
    if (RESCUE.has(model)) return "hold";
    return { kind: "delete", why: `points at ${matched.map((m) => m.split("→")[1]).join(", ")}` };
  };

  const plan = await walk(removeIds, (model, row, matched) => decideGeneric(model, row, matched));
  const W = plan.w;
  const removedProjects = () => new Set([...W.decision].filter(([key, d]) => d.kind === "delete" && key.startsWith("Project:")).map(([key]) => key.slice(8)));

  // Decide held rescue rows: CommLog first (tasks follow their emails), then
  // Contact, ClientAsk, SmartTask. Repeat while deleting a row reaches more.
  const decideHeld = async (keys: string[]): Promise<string[]> => {
    const order = ["CommLog", "Contact", "ClientAsk", "SmartTask"];
    // inbound mail before our sent replies, so a reply can follow its thread's decision
    const rank = (key: string) => order.indexOf(key.split(":")[0]) * 2 + (W.rows.get(key)!.row.direction === "out" ? 1 : 0);
    keys.sort((a, b) => rank(a) - rank(b));
    const toDelete: string[] = [];
    const commByThread = new Map<string, Decision>();
    const rp = removedProjects();
    const clearProject = (row: Row): Row => (typeof row.projectId === "string" && (rp.has(row.projectId) || removeSet.has(projectClient.get(row.projectId) ?? "")) ? { projectId: null } : {});
    const seedOf = (key: string) => [...(W.prov.get(key) ?? [])][0];
    for (const key of keys) {
      const { model, row } = W.rows.get(key)!;
      const seed = seedOf(key);
      const synthetic = isSeedSynthetic(seed);
      let d: Decision;
      if (model === "CommLog") {
        const subject = String(row.subject ?? "");
        const body = String(row.body ?? "");
        const contact = String(row.contactName ?? "");
        const out = row.direction === "out";
        const staff = out || isStaffAddr(contact) || staffNames.has(lc(contact)) || (!contact && !row.fromPhone);
        const ext = String(row.externalId ?? "");
        const thread = threadOf(ext);
        const greetsTarget = targets.some((t) => new RegExp(`^\\s*(hi|hey|hello|dear)\\s+${t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body));
        const ownerOnly = (w: string): Decision => ({ kind: "ownerOnly", why: w, set: { clientId: null, clientName: null, projectId: null, projectGuess: false, minRole: "OWNER" } });
        if (mentionsTest(`${subject}\n${body.slice(0, 400)}`) || /^\s*(test|testing)\W*$/i.test(body) || (staff && greetsTarget)) d = { kind: "delete", why: staff && greetsTarget ? "test traffic: our mail addressed to the removed client itself" : "test traffic: names a test client / says test" };
        else if (synthetic && (staff || T.isVerifiedTestDestinationEmail(contact) || T.isVerifiedTestDestinationPhone(String(row.fromPhone ?? "")))) d = { kind: "delete", why: "a test client's own traffic" };
        else if (staff) {
          const fwd = !out ? forwardedFrom(subject, body) : null;
          if (fwd) {
            const p = tiers({ emails: [fwd], names: [fwdDisplay(body, fwd)] });
            if (p && "clientId" in p) d = { kind: "move", to: p.clientId, toName: nameOf.get(p.clientId) ?? "?", why: `staff forward of ${fwd}: ${p.why}`, set: { clientId: p.clientId, clientName: nameOf.get(p.clientId) ?? null, ...clearProject(row), projectGuess: false } };
            else d = { kind: "unplaced", why: `staff forward of ${fwd}${fwdDisplay(body, fwd) ? ` (${fwdDisplay(body, fwd)})` : ""}: ${p && "ambiguous" in p ? p.ambiguous : "no client has this address, name or domain"}`, fallback: { clientId: null, clientName: null, projectId: null, projectGuess: false, minRole: "OWNER" } };
          } else if (out && thread) {
            const root = commByThread.get(thread);
            const tc = root?.kind === "move" ? root.to : await threadClient(thread);
            const how = root?.kind === "move" ? `our sent reply to the forward it answers (moved to ${nameOf.get(tc!)})` : `our sent reply in a Gmail thread filed under ${nameOf.get(tc ?? "")}`;
            d = tc ? { kind: "move", to: tc, toName: nameOf.get(tc) ?? "?", why: how, set: { clientId: tc, clientName: nameOf.get(tc) ?? null, ...clearProject(row), projectGuess: false } } : ownerOnly("our own sent reply; its thread is not filed under any real client");
          } else d = ownerOnly(isOwnerAddr(contact) || lc(contact) === "jordan spackman" ? "Jordan's own mail (not a forward)" : "a staff note (not a forward)");
        } else {
          const emails = contact.includes("@") ? [contact] : [];
          const p = tiers({ emails, names: contact.includes("@") ? [] : [contact] });
          if (p && "clientId" in p) d = { kind: "move", to: p.clientId, toName: nameOf.get(p.clientId) ?? "?", why: `from ${contact || row.fromPhone}: ${p.why}`, set: { clientId: p.clientId, clientName: nameOf.get(p.clientId) ?? null, ...clearProject(row), projectGuess: false } };
          else d = { kind: "unplaced", why: `from ${contact || row.fromPhone || "nobody"}: ${p && "ambiguous" in p ? p.ambiguous : "no client matches"}`, fallback: { clientId: null, clientName: null, projectId: null, projectGuess: false, minRole: "OWNER" } };
        }
        if (thread && !out) commByThread.set(thread, d);
      } else if (model === "Contact") {
        const email = lc(row.email);
        const name = [row.firstName, row.lastName].filter(Boolean).join(" ");
        if (email && (isOwnerAddr(email) || isStaffAddr(email))) d = { kind: "unlink", why: `Jordan's own / staff address ${email}: unlinked, kept`, set: { clientId: null } };
        else if (T.isVerifiedTestDestinationEmail(email) || T.isTestClientName(name) || /^bob mike$/i.test(name) || (lc(name) === "jordan spackman")) d = { kind: "delete", why: `test identity ${email || "(no email)"} "${name}"` };
        else {
          const p = tiers({ emails: email ? [email] : [], names: [name] });
          if (p && "clientId" in p) d = { kind: "move", to: p.clientId, toName: nameOf.get(p.clientId) ?? "?", why: `${email || name}: ${p.why}`, set: { clientId: p.clientId } };
          else d = { kind: "unplaced", why: `contact ${email || "(no email)"} "${name}": ${p && "ambiguous" in p ? p.ambiguous : "no client matches"}`, fallback: { clientId: null } };
        }
      } else {
        // ClientAsk / SmartTask
        const isTask = model === "SmartTask";
        const text = isTask ? `${row.title ?? ""}\n${row.summary ?? ""}\n${row.description ?? ""}` : `${row.summary ?? ""}\n${row.text ?? ""}`;
        const source = lc(row.source);
        const thread = isTask ? /^gmail-thread:[^:]+:([0-9a-f]+)$/.exec(String(row.sourceDetail ?? ""))?.[1] ?? null : null;
        const fromMessage = MESSAGE_TASK_SOURCES.has(source) || !!thread;
        const linked = thread ? commByThread.get(thread) : undefined;
        const moveTo = (cid: string, w: string, projectId?: string): Decision => ({ kind: "move", to: cid, toName: nameOf.get(cid) ?? "?", why: w, set: isTask ? { clientId: cid, projectId: projectId ?? (clearProject(row).projectId === null ? null : row.projectId ?? null) } : { clientId: cid, projectId: projectId ?? null } });
        if (synthetic || mentionsTest(text)) d = { kind: "delete", why: synthetic ? "a test client's own work item" : "test: names a test client" };
        else if (linked?.kind === "delete") d = { kind: "delete", why: `its email is deleted too (${linked.why})` };
        else if (linked?.kind === "move") d = moveTo(linked.to, `follows its email (${linked.why})`);
        else if (thread && !linked && (await threadClient(thread))) { const tc = (await threadClient(thread))!; d = moveTo(tc, `its Gmail thread is filed under ${nameOf.get(tc)}`); }
        else if (fromMessage) {
          const p = tiers({ emails: emailsIn(text), names: [], text, job: text });
          if (p && "clientId" in p) d = moveTo(p.clientId, p.why, p.projectId);
          else if (isTask && (linked?.kind === "ownerOnly" || source === "gmail")) d = p && "ambiguous" in p
            ? { kind: "unplaced", why: `${p.ambiguous}`, fallback: { clientId: null, projectId: null } }
            : { kind: "ownerOnly", why: "from Jordan's own mail and names no other client", set: { clientId: null, projectId: null } };
          else d = { kind: "unplaced", why: p && "ambiguous" in p ? p.ambiguous : "came from a message and names no client", fallback: isTask ? { clientId: null, projectId: null } : "delete" };
        } else if (OPERATIONAL_TASK_SOURCES.has(source) || !isTask) d = { kind: "delete", why: `the removed client's own ${isTask ? `${row.taskType} task` : "ask"}` };
        else d = { kind: "unplaced", why: `task from "${source}" on the removed client`, fallback: { clientId: null, projectId: null } };
      }
      W.decision.set(key, d);
      if (d.kind === "delete") toDelete.push(key);
    }
    return toDelete;
  };
  let held = plan.held;
  while (held.length) {
    const before = new Set(W.decision.keys());
    const del = await decideHeld(held);
    const feed = (W as Walk & { feed: (keys: string[]) => Promise<void> }).feed;
    const heldBefore = new Set(plan.held);
    await feed(del);
    held = plan.held.filter((key) => !heldBefore.has(key) && !before.has(key) && !W.decision.has(key));
  }

  // ---- print the plan --------------------------------------------------------
  const group = (kind: Decision["kind"]) => [...W.decision].filter(([, d]) => d.kind === kind);
  const describe = (key: string) => {
    const { model, row } = W.rows.get(key)!;
    const s = model === "CommLog" ? `${row.direction} ${row.source} ${String(row.occurredAt instanceof Date ? (row.occurredAt as Date).toISOString().slice(0, 10) : "")} "${one(row.subject, 70)}"` :
      model === "SmartTask" ? `[${row.taskType}, ${row.status}] "${one(row.title, 80)}"` :
      model === "Contact" ? `${row.email ?? "(no email)"} "${[row.firstName, row.lastName].filter(Boolean).join(" ")}"` :
      `"${one(sampleOf(model, row) ?? "", 80)}"`;
    return `${model} ${String(row[idOf(model)])} ${s}`;
  };
  const moves = group("move");
  console.log(`\nRESCUE — PROPOSED MOVES (${moves.length})`);
  for (const [key, d] of moves) if (d.kind === "move") console.log(`  · ${describe(key)}\n      → ${d.toName} (${d.to}) because ${d.why}${"projectId" in d.set && d.set.projectId ? `, job ${d.set.projectId}` : ""}`);
  const ownerOnly = group("ownerOnly");
  console.log(`\nRESCUE — OWNER-ONLY, NO CLIENT (${ownerOnly.length})`);
  for (const [key, d] of ownerOnly) if (d.kind === "ownerOnly") console.log(`  · ${describe(key)} — ${d.why}`);
  const unlinks = group("unlink");
  console.log(`\nUNLINK — kept, the reference to the removed row cleared (${unlinks.length})`);
  for (const [key, d] of unlinks) if (d.kind === "unlink") console.log(`  · ${describe(key)} — ${d.why}`);
  const unplaced = group("unplaced");
  console.log(`\nNEEDS A PERSON (${unplaced.length})${unplaced.length ? (ACCEPT_UNPLACED ? " — --accept-unplaced: each becomes owner-only / unlinked (or deleted where noted)" : " — --apply refuses until these are placed or --accept-unplaced is given") : ""}`);
  for (const [key, d] of unplaced) if (d.kind === "unplaced") console.log(`  · ${describe(key)}\n      ${d.why}; if accepted: ${d.fallback === "delete" ? "DELETED (backed up)" : `set ${JSON.stringify(d.fallback)}`}`);
  const rescueDeletes = [...W.decision].filter(([key, d]) => d.kind === "delete" && RESCUE.has(key.split(":")[0]));
  console.log(`\nRESCUE — DELETED WITH THE CLIENT (test traffic / the client's own work) (${rescueDeletes.length})`);
  for (const [key, d] of rescueDeletes) if (d.kind === "delete") console.log(`  · ${describe(key)} — ${d.why}`);

  console.log(`\nREAL BUSINESS, LEFT ALONE (${leftAlone.size})`);
  for (const [id, ev] of leftAlone) { console.log(`  · "${targetName.get(id)}" ${id}`); for (const e of ev) console.log(`      ${e}`); }

  // AppSetting rows KEYED by a removed client, job or enrollment id
  // ("portal-prefill-<enrollment>", "editing-removed:<job>", "client-onboarding:
  // <client>", "comms-ack-…<client>…") are that row's leftovers: removed with it.
  // A setting that only MENTIONS an id in its value (a sweep cursor, the dedupe
  // candidate list) is left alone; both recompute.
  const settingIds = new Map<string, Set<string>>();
  for (const [key, d] of W.decision) if ((d.kind === "delete" || d.kind === "target") && /^(Client|Project|ContentEnrollment):/.test(key)) settingIds.set(key.slice(key.indexOf(":") + 1), W.prov.get(key)!);
  for (const s of await prisma.appSetting.findMany()) {
    if (s.key === REMOVED_CLIENTS_KEY) continue;
    const hit = [...settingIds.keys()].find((id) => s.key.includes(id));
    if (!hit) continue;
    const key = k("AppSetting", s.key);
    W.rows.set(key, { model: "AppSetting", row: s as unknown as Row });
    W.decision.set(key, { kind: "delete", why: `keyed by removed ${hit}` });
    W.prov.set(key, new Set(settingIds.get(hit)));
  }
  // Bell items whose link opens a removed job or client: removed with it.
  const sIds = [...settingIds.keys()];
  for (let i = 0; i < sIds.length; i += 200) {
    for (const n of await prisma.notification.findMany({ where: { OR: sIds.slice(i, i + 200).map((id) => ({ href: { contains: id } })) } })) {
      const hit = sIds.find((id) => n.href.includes(id))!;
      const key = k("Notification", n.id);
      if (W.decision.has(key)) continue;
      W.rows.set(key, { model: "Notification", row: n as unknown as Row });
      W.decision.set(key, { kind: "delete", why: `links to removed ${hit}` });
      W.prov.set(key, new Set(settingIds.get(hit)));
      // Its delivery log rows (plain notificationId, no relation) go with it
      // (Oct 23: Cara TEST's removal rolled back on 10 of these).
      for (const d of await prisma.notificationDelivery.findMany({ where: { notificationId: n.id } })) {
        const dk = k("NotificationDelivery", d.id);
        if (W.decision.has(dk)) continue;
        W.rows.set(dk, { model: "NotificationDelivery", row: d as unknown as Row });
        W.decision.set(dk, { kind: "delete", why: `delivery of removed bell item ${n.id}` });
        W.prov.set(dk, new Set(settingIds.get(hit)));
      }
    }
  }

  // --accept-unplaced: an unplaced row whose fallback is a delete is deleted
  // (and whatever only it reaches); every other unplaced row is changed.
  if (ACCEPT_UNPLACED) {
    const conv = unplaced.filter(([, d]) => d.kind === "unplaced" && d.fallback === "delete").map(([key]) => key);
    for (const key of conv) W.decision.set(key, { kind: "delete", why: "needs a person; accepted (--accept-unplaced)" });
    if (conv.length) await (W as Walk & { feed: (keys: string[]) => Promise<void> }).feed(conv);
  }

  // deletes by model, children first by the live foreign keys
  const delKeys =[...W.decision].filter(([, d]) => d.kind === "delete" || d.kind === "target").map(([key]) => key);
  const delByModel = new Map<string, string[]>();
  for (const key of delKeys) { const m = key.split(":")[0]; if (!delByModel.has(m)) delByModel.set(m, []); delByModel.get(m)!.push(key.slice(m.length + 1)); }
  const delModels = [...delByModel.keys()];
  const orderModels = (ms: string[]): string[] => {
    const set = new Set(ms);
    const edges = liveFks.filter((f) => set.has(f.child) && set.has(f.parent) && f.child !== f.parent);
    const out: string[] = [];
    const left = new Set(ms);
    while (left.size) {
      const ready = [...left].filter((m) => !edges.some((e) => e.parent === m && left.has(e.child)));
      if (!ready.length) throw new Error(`foreign-key cycle among ${[...left].join(", ")}`);
      for (const m of ready.sort()) { out.push(m); left.delete(m); }
    }
    return out;
  };
  const deleteOrder = orderModels(delModels);
  const fkProblems: string[] = [];
  // A row that is KEPT (moved, owner-only, unlinked, accepted) must not keep
  // any other id that points at a removed row either (a task's outputId, a
  // log's projectId): every such column is cleared with the rest of its change.
  const removedIdSet = new Set(delKeys.map((key) => key.slice(key.indexOf(":") + 1)));
  for (const [key, d] of W.decision) {
    if (!(d.kind === "move" || d.kind === "ownerOnly" || d.kind === "unlink" || (d.kind === "unplaced" && d.fallback !== "delete"))) continue;
    const { model, row } = W.rows.get(key)!;
    const set = d.kind === "unplaced" ? (d.fallback as Row) : d.set;
    for (const f of refFields.get(model) ?? []) {
      if (f.name in set) continue;
      const v = row[f.name];
      if (f.list && Array.isArray(v) && v.some((x) => removedIdSet.has(x))) set[f.name] = v.filter((x) => !removedIdSet.has(x));
      else if (typeof v === "string" && removedIdSet.has(v)) {
        if (f.required) fkProblems.push(`${key} is kept but its REQUIRED ${f.name} points at removed ${v}`);
        else set[f.name] = null;
      }
    }
  }
  // Every live FK into a removed table: is each child row either removed or explicitly changed?
  for (const f of liveFks) {
    const parentIds = delByModel.get(f.parent);
    if (!parentIds?.length || KEEP_LOGS.has(f.child)) continue;
    const fieldName = byName.get(f.child)?.fields.find((x) => x.name === f.col || (x as Field & { dbName?: string }).dbName === f.col)?.name ?? f.col;
    const rows = await db[BF.delegateName(f.child)].findMany({ where: { [fieldName]: { in: parentIds } }, select: { [idOf(f.child)]: true } });
    for (const r of rows) {
      const key = k(f.child, String(r[idOf(f.child)]));
      const d = W.decision.get(key);
      if (d?.kind === "delete" || d?.kind === "target") continue;
      if ((d?.kind === "unlink" || d?.kind === "move" || d?.kind === "ownerOnly") && fieldName in d.set) continue;
      // listed under NEEDS A PERSON; --apply refuses without --accept-unplaced, whose fallback covers this column
      if (d?.kind === "unplaced" && (d.fallback === "delete" || fieldName in d.fallback)) continue;
      fkProblems.push(`${key} → ${f.parent} via ${fieldName} (ON DELETE ${f.onDelete}) is neither removed nor unlinked`);
    }
  }

  const changeKeys = [...W.decision].filter(([, d]) => ["move", "ownerOnly", "unlink"].includes(d.kind) || (d.kind === "unplaced" && ACCEPT_UNPLACED)).map(([key]) => key);
  const keepLogs = group("keepLog");
  console.log(`\nDELETE PLAN — ${delKeys.length} row(s) in ${deleteOrder.length} model(s), children first (order from pg_constraint):`);
  for (const m of deleteOrder) {
    const fksIn = liveFks.filter((f) => f.parent === m && delByModel.has(f.child)).map((f) => `${f.child}.${f.col} ${f.onDelete}`);
    console.log(`  ${String(delByModel.get(m)!.length).padStart(5)}  ${m}${fksIn.length ? `   (FKs in: ${fksIn.join("; ")})` : ""}`);
  }
  console.log(`  changed (moved / owner-only / unlinked${ACCEPT_UNPLACED ? " / accepted unplaced" : ""}): ${changeKeys.length}; log rows kept: ${keepLogs.length}${keepLogs.length ? ` (${[...new Set(keepLogs.map(([key]) => key.split(":")[0]))].join(", ")})` : ""}`);
  if (fkProblems.length) { console.log(`  FOREIGN-KEY PROBLEMS (${fkProblems.length}) — --apply refuses:`); for (const p of fkProblems) console.log(`    ✗ ${p}`); }
  else console.log(`  every database foreign key into a removed row is covered (removed or explicitly cleared); no cascade or SET NULL is relied on`);

  // groups: clients whose removed rows overlap are removed in one transaction
  const parent = new Map(removeIds.map((id) => [id, id]));
  const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x)!));
  for (const key of [...delKeys, ...changeKeys]) { const p = [...(W.prov.get(key) ?? [])]; for (let i = 1; i < p.length; i++) parent.set(find(p[i]), find(p[0])); }
  const groups = new Map<string, string[]>();
  for (const id of removeIds) { const r = find(id); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(id); }
  console.log(`  transactions: ${groups.size} — ${[...groups.values()].map((g) => g.map((id) => `"${targetName.get(id)}"`).join(" + ")).join(" | ")}`);

  // ---- the removed-clients record --------------------------------------------
  const removedProjectRows = await prisma.project.findMany({ where: { id: { in: delByModel.get("Project") ?? [] } }, select: { aryeoOrderId: true, clientId: true } });
  const stillHeld = new Set<string>();
  for (const c of others) { if (c.email) stillHeld.add(lc(c.email)); if (c.backupEmail) stillHeld.add(lc(c.backupEmail)); }
  for (const id of leftAlone.keys()) { const t = targets.find((x) => x.id === id)!; if (t.email) stillHeld.add(lc(t.email)); if (t.backupEmail) stillHeld.add(lc(t.backupEmail)); }
  const tombstones = targets.filter((t) => removeSet.has(t.id)).map((t) => {
    const emails = [t.email, t.backupEmail].map(lc).filter(Boolean);
    return {
      clientId: t.id,
      name: t.name,
      aryeoCustomerIds: t.aryeoCustomerId ? [t.aryeoCustomerId] : [],
      emails: emails.filter((e) => !stillHeld.has(e)),
      skippedEmails: emails.filter((e) => stillHeld.has(e)),
      aryeoOrderIds: removedProjectRows.filter((p) => p.clientId === t.id && p.aryeoOrderId).map((p) => p.aryeoOrderId!),
      removedAt: new Date().toISOString(),
      note: "Jordan, Oct 23 2026: remove the Jordan Spackman and test client records (scripts/_live/oct23-remove-test-clients.ts)",
    };
  });
  const currentRecord = await prisma.appSetting.findUnique({ where: { key: REMOVED_CLIENTS_KEY } });
  console.log(`\nRE-CREATION GUARD — AppSetting "${REMOVED_CLIENTS_KEY}" (read by the Aryeo roster sweep, order sync and customer webhook):`);
  for (const t of tombstones) console.log(`  · "${t.name}" ${t.clientId}: Aryeo customer ${t.aryeoCustomerIds.join(", ") || "-"}; emails ${t.emails.join(", ") || "-"}${t.skippedEmails.length ? ` (not listed, another client still holds: ${t.skippedEmails.join(", ")})` : ""}; Aryeo orders ${t.aryeoOrderIds.length ? t.aryeoOrderIds.join(", ") : "-"}`);
  console.log(`  current record: ${currentRecord ? `${parseRemovedClients(currentRecord.value).entries.length} entr(ies)` : "none"}`);

  // ---- other references: settings, tokens, demo pages ------------------------
  const watchIds = [...removeIds, ...(delByModel.get("Project") ?? []), ...(delByModel.get("ContentEnrollment") ?? [])];
  const tokens = enrollments.filter((e) => removeSet.has(e.clientId) && e.portalToken).map((e) => e.portalToken!);
  const settings = await prisma.appSetting.findMany({ select: { key: true, value: true } });
  const settingHits = settings.filter((s) => watchIds.some((id) => s.key.includes(id) || s.value.includes(id)) || tokens.some((t) => s.value.includes(t)));
  console.log(`\nOTHER REFERENCES`);
  console.log(`  AppSetting rows naming a removed client, job, enrollment or portal token: ${settingHits.length}`);
  for (const s of settingHits) console.log(`    · ${W.decision.get(k("AppSetting", s.key))?.kind === "delete" ? "REMOVED (keyed by a removed id)" : "left (value only; recomputed)"}  ${s.key}: ${one(s.value, 110)}`);
  const docHits = (await prisma.hubDocument.findMany() as unknown as Row[]).filter((r) => watchIds.some((id) => JSON.stringify(r).includes(id)) || tokens.some((t) => JSON.stringify(r).includes(t)));
  console.log(`  HubDocument rows naming one: ${docHits.length}${docHits.length ? ` (${docHits.map((d) => `${String(d.id)} "${one(d.title, 40)}"`).join(", ")})` : ""}`);
  console.log(`  Notification (bell) rows linking to a removed job or client: ${delByModel.get("Notification")?.length ?? 0} — removed with it`);
  console.log(`  portal tokens that stop working: ${tokens.length} (${enrollments.filter((e) => removeSet.has(e.clientId) && e.portalToken).map((e) => `${targetName.get(e.clientId)} enrollment ${e.id}`).join(", ") || "-"})`);

  // ---- the backup payload -----------------------------------------------------
  const backupData: Record<string, Row[]> = {};
  const push = (model: string, row: Row) => { (backupData[model] ??= []).push(row); };
  for (const key of delKeys) { const { model, row } = W.rows.get(key)!; push(model, row); }
  for (const key of changeKeys) { const { model, row } = W.rows.get(key)!; push(model, row); }
  if (currentRecord) push("AppSetting", currentRecord as unknown as Row);
  const counts = Object.fromEntries(Object.entries(backupData).map(([m, rs]) => [m, rs.length]));
  const backupRows = Object.values(counts).reduce((a, b) => a + b, 0);
  const planIndex = {
    delete: Object.fromEntries([...delByModel].map(([m, ids]) => [m, ids])),
    change: changeKeys.map((key) => { const d = W.decision.get(key)!; const set = d.kind === "unplaced" ? (d.fallback === "delete" ? "delete" : d.fallback) : (d as { set: Row }).set; return { key, set }; }),
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(BACKUP_DIR, `oct23-remove-test-clients-${stamp}.json`);
  console.log(`\nBACKUP PLAN`);
  console.log(`  JSON backup: ${backupRows} row(s), every column (${delKeys.length} to delete + ${changeKeys.length} before-images of changed rows${currentRecord ? " + the current removed-clients record" : ""}) → ${WRITE_BACKUP ? backupFile : `${BACKUP_DIR}/oct23-remove-test-clients-<timestamp>.json`}`);
  console.log(`    by model: ${Object.entries(counts).map(([m, n]) => `${m} ${n}`).join(", ")}`);
  console.log(`  repo "backups/" is NOT gitignored, so the file goes to the session scratchpad (override with --backup-dir=<dir>, e.g. ~/rtp-backups).`);
  console.log(`  whole-hub backup (the app's own tool, scripts/backup-all.ts: one repeatable-read snapshot, read-only, 0600): ${FULL_BACKUP ? `--full-backup=${FULL_BACKUP}` : `~/rtp-backups/full-${new Date().toISOString().slice(0, 10)}-before-remove-test-clients.json`} — taken by --apply before any write`);
  console.log(`  primary recovery remains Neon point-in-time restore; --apply prints the database clock just before its first write.`);

  if (WRITE_BACKUP) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
    const { bytes } = BF.writeBackupFile(backupFile, {
      takenAt: new Date().toISOString(),
      commit: BF.headCommit() ?? "unknown",
      schemaHash: schemaText ? BF.schemaHashOf(schemaText) : "unknown",
      prismaVersion: Prisma.prismaVersion.client,
      snapshot: "targeted: rows deleted or changed by scripts/_live/oct23-remove-test-clients.ts",
      counts,
      rows: backupRows,
      ...({ purpose: "oct23 remove test clients", targets: targets.map((t) => ({ id: t.id, name: t.name, removed: removeSet.has(t.id) })), plan: planIndex, tombstones } as object),
    }, backupData);
    const back = await BF.readBackup(backupFile);
    const reread = Object.values(back.data).reduce((a, b) => a + b.length, 0);
    if (reread !== backupRows) throw new Error(`backup re-read ${reread} rows, wrote ${backupRows}`);
    console.log(`  WRITTEN: ${backupFile} (${(bytes / 1024).toFixed(1)} KB, mode 600, ${reread} rows re-read)`);
  }

  // ---- refusals ----------------------------------------------------------------
  if (!APPLY) {
    console.log(`\nDRY RUN: nothing written to the database.${unplaced.length && !ACCEPT_UNPLACED ? ` --apply would REFUSE: ${unplaced.length} row(s) need a person.` : ""}${fkProblems.length ? " --apply would REFUSE: foreign-key problems above." : ""}`);
    await prisma.$disconnect();
    return;
  }
  if (unplaced.length && !ACCEPT_UNPLACED) throw new Error(`REFUSED: ${unplaced.length} row(s) need a person (see the list). Place them, or pass --accept-unplaced.`);
  if (fkProblems.length) throw new Error(`REFUSED: ${fkProblems.length} foreign-key problem(s).`);

  // ---- APPLY ---------------------------------------------------------------------
  // b. whole-hub backup through the app's own tool
  if (FULL_BACKUP) {
    const h = BF.readBackupHeader(FULL_BACKUP).header;
    const age = Date.now() - Date.parse(h.takenAt);
    if (!(age >= 0 && age < 6 * 3600_000) || !h.counts?.Client) throw new Error(`REFUSED: --full-backup ${FULL_BACKUP} was taken ${h.takenAt} (needs < 6h, with Client rows)`);
    console.log(`\nwhole-hub backup: using ${FULL_BACKUP} (taken ${h.takenAt}, ${Object.values(h.counts).reduce((a, b) => a + b, 0)} rows)`);
  } else {
    const dir = path.join(os.homedir(), "rtp-backups");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out = path.join(dir, `full-${new Date().toISOString().slice(0, 10)}-before-remove-test-clients-${Date.now()}.json`);
    console.log(`\nwhole-hub backup: scripts/backup-all.ts → ${out}`);
    const r = spawnSync(process.execPath, [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "scripts/backup-all.ts"), out], { stdio: "inherit", env: process.env, cwd: REPO });
    if (r.status !== 0 || !fs.existsSync(out)) throw new Error("REFUSED: the whole-hub backup failed; nothing was changed");
  }

  // c. the removed-clients record
  const [{ now }] = await prisma.$queryRawUnsafe<{ now: Date }[]>(`SELECT now() AS now`);
  console.log(`database clock before the first write (for a Neon point-in-time restore): ${new Date(now).toISOString()}`);
  const value = mergeRemovedClients(currentRecord?.value, tombstones.map(({ skippedEmails: _s, ...t }) => { void _s; return t; }));
  await prisma.appSetting.upsert({ where: { key: REMOVED_CLIENTS_KEY }, create: { key: REMOVED_CLIENTS_KEY, value, updatedBy: "oct23-remove-test-clients" }, update: { value, updatedBy: "oct23-remove-test-clients" } });
  console.log(`removed-clients record written (${parseRemovedClients(value).entries.length} entries)`);

  // d. one transaction per group
  type Tx = Record<string, { updateMany: (a: unknown) => Promise<{ count: number }>; deleteMany: (a: unknown) => Promise<{ count: number }>; count: (a: unknown) => Promise<number> }>;
  for (const ids of groups.values()) {
    const g = new Set(ids);
    const inGroup = (key: string) => [...(W.prov.get(key) ?? [])].some((c) => g.has(c));
    const label = ids.map((id) => `"${targetName.get(id)}"`).join(" + ");
    try {
      await prisma.$transaction(async (txc) => {
        const tx = txc as unknown as Tx;
        let changed = 0;
        for (const key of changeKeys.filter(inGroup)) {
          const { model, row } = W.rows.get(key)!;
          const d = W.decision.get(key)!;
          const set = d.kind === "unplaced" ? (d.fallback as Row) : (d as { set: Row }).set;
          const guard: Row = { [idOf(model)]: row[idOf(model)] };
          for (const f of Object.keys(set)) guard[f] = Array.isArray(row[f]) ? { equals: row[f] } : row[f] ?? null;
          const r = await tx[BF.delegateName(model)].updateMany({ where: guard, data: set });
          if (r.count !== 1) throw new Error(`${key} changed since the plan (update matched ${r.count})`);
          changed++;
        }
        let deleted = 0;
        for (const m of deleteOrder) {
          const idsM = (delByModel.get(m) ?? []).filter((id) => inGroup(k(m, id)));
          if (!idsM.length) continue;
          const r = await tx[BF.delegateName(m)].deleteMany({ where: { [idOf(m)]: { in: idsM } } });
          if (r.count !== idsM.length) throw new Error(`${m}: deleted ${r.count}, planned ${idsM.length}`);
          deleted += r.count;
        }
        // nothing may still point at the removed clients or their removed jobs
        const gone = [...new Set([...ids, ...delKeys.filter(inGroup).map((key) => key.slice(key.indexOf(":") + 1))])];
        const left: string[] = [];
        for (const [model, fields] of refFields) {
          if (KEEP_LOGS.has(model)) continue;
          let n = 0;
          for (let i = 0; i < gone.length; i += 1000) {
            const chunk = gone.slice(i, i + 1000);
            n += await tx[BF.delegateName(model)].count({ where: { OR: fields.map((f) => (f.list ? { [f.name]: { hasSome: chunk } } : { [f.name]: { in: chunk } })) } });
          }
          if (n) left.push(`${model} ${n}`);
        }
        if (left.length) throw new Error(`rows still point at removed rows after the delete: ${left.join(", ")}`);
        console.log(`  ✓ ${label}: ${changed} changed, ${deleted} deleted, nothing left pointing at them`);
      }, { timeout: 180_000, maxWait: 30_000 });
    } catch (e) {
      console.error(`  ✗ ${label}: ROLLED BACK — ${(e as Error).message}`);
      process.exitCode = 1;
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
