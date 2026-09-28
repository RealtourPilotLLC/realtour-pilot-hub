// ---------------------------------------------------------------------------
// SET ONE TEST FIXTURE'S HUB EMAIL (Sep 28 2026).
//
// Jordan, Sep 28: "the test email for bobby test can just be my
// jspackman215@gmail.com so I can see the test emails." This is that one
// change, for the main session to run. It edits exactly ONE column, Client.email,
// on exactly ONE TEST client, and nothing in any provider (Aryeo keeps
// bobmike0214@gmail.com on Bobby's customer; that is also one of Jordan's
// verified inboxes, so the fixture identity still holds).
//
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/set-fixture-email.ts \
//       --client cmtl98xl90008jl04yt5zawnv --email jspackman215@gmail.com
//       DRY RUN (the default), on a connection that CANNOT write (proved first):
//       prints the row, the change, who else is on that inbox, and the refusal
//       if there is one. Writes nothing, backs nothing up.
//   … --apply   (optional --backup-dir <dir>, default your home directory)
//       1. backs the whole before-row up OUTSIDE the repository, mode 0600:
//          ~/rtp-backup-<ET date>-fixture-<clientId>.json (never overwrites)
//       2. one transaction: the email, compare-and-set on the row as read, and
//          an AuditLog row (action fixture_email_change, target client:<id>)
//       3. reads the row back and prints before → after
//
// IT REFUSES, and writes nothing (no backup, no audit row), when:
//   · the client does not exist, or more than one --client is given;
//   · the id is on NEVER_SYNTHETIC_CLIENT_IDS — checked BEFORE the name, so a
//     real row renamed "… TEST" is still refused;
//   · the name is not a TEST name (isTestClientName);
//   · the new address is not one of Jordan's verified test inboxes
//     (isVerifiedTestDestinationEmail — info@realtourpilot.com, his two Gmail
//     inboxes; a stranger's Gmail and lookalikes are refused);
//   · the CURRENT email is somebody else's (set, and not a verified inbox): this
//     moves a fixture between Jordan's own inboxes; it never takes a row off a
//     stranger's inbox — a real client with TEST in its name is not laundered
//     into a fixture by pointing it at Jordan;
//   · the row is linked to a never-synthetic row's Aryeo customer
//     (NEVER_SYNTHETIC_ARYEO_CUSTOMER_IDS);
//   · the backup directory is inside the repository.
// And with --apply, if the row changed between the read and the write
// (compare-and-set), the transaction writes nothing and no audit row; the
// backup already taken is then simply the unchanged row.
// Already on that exact address → "no change", exit 0, nothing written.
//
// Proven on PGlite only (scripts/_drill/test-inboxes.ts §4). Prisma self-loads
// .env: with --apply this writes to the LIVE database, by design.
// ---------------------------------------------------------------------------
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalInbox,
  isNeverSyntheticAryeoCustomerId,
  isNeverSyntheticClientId,
  isTestClientName,
  isVerifiedTestDestinationEmail,
  isVerifiedTestDestinationPhone,
  JORDAN_TEST_INBOXES_TEXT,
} from "../../src/lib/testClients";

type Log = (line: string) => void;
export type SetFixtureEmailResult = {
  code: number;
  mode: "dry-run" | "apply";
  refused?: string;
  clientId?: string;
  from?: string | null;
  to?: string;
  changed?: boolean;
  backupPath?: string;
  auditId?: string;
};

export const SET_FIXTURE_EMAIL_SCRIPT = "NODE_OPTIONS=--conditions=react-server npx tsx scripts/_ops/set-fixture-email.ts";
export const FIXTURE_EMAIL_AUDIT_ACTION = "fixture_email_change";
const ACTOR = "scripts/_ops/set-fixture-email.ts (main session)";
const REPO = path.resolve(__dirname, "../..");
const PLAIN_EMAIL = /^[^\s@"<>(),;:]+@[^\s@"<>(),;:]+\.[a-z]{2,}$/i;

const argValues = (argv: string[], name: string): string[] => {
  const out: string[] = [];
  argv.forEach((a, i) => {
    if (a === name && argv[i + 1] && !argv[i + 1].startsWith("--")) out.push(argv[i + 1]);
    else if (a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
  });
  return out;
};

/** The ET calendar day, YYYY-MM-DD: the backup is named for the business day it was taken. */
const etDay = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export async function setFixtureEmail(
  db: PrismaClient,
  argv: string[],
  opts: { log?: Log; now?: Date; backupDir?: string } = {},
): Promise<SetFixtureEmailResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const apply = argv.includes("--apply");
  const mode = apply ? "apply" : "dry-run";
  const refuse = (why: string, extra: Partial<SetFixtureEmailResult> = {}): SetFixtureEmailResult => {
    log(`REFUSED: ${why} Nothing was written.`);
    return { code: 2, mode, refused: why, ...extra };
  };

  const ids = argValues(argv, "--client");
  const emails = argValues(argv, "--email");
  if (ids.length !== 1) return refuse(`pass exactly one --client <clientId> (got ${ids.length}). This script changes ONE fixture at a time.`);
  if (emails.length !== 1) return refuse(`pass exactly one --email <address> (got ${emails.length}).`);
  const clientId = ids[0].trim();
  const to = emails[0].trim().toLowerCase();

  log(`Set fixture email — ${apply ? "APPLY (one column on one TEST client, audited)" : "DRY RUN (reads only)"}`);

  // ---- the address first: it needs no read ---------------------------------
  if (!PLAIN_EMAIL.test(to)) return refuse(`"${emails[0]}" is not a plain email address.`, { clientId });
  if (!isVerifiedTestDestinationEmail(to)) {
    return refuse(`${to} is not one of Jordan's verified test inboxes (${JORDAN_TEST_INBOXES_TEXT}). A fixture's email may only be one of those.`, { clientId, to });
  }

  // ---- the row, and that it IS a fixture ----------------------------------
  const row = await db.client.findUnique({ where: { id: clientId } });
  if (!row) return refuse(`client ${clientId} does not exist.`, { clientId, to });
  // Id before name: a real row renamed "… TEST" must still be refused.
  if (isNeverSyntheticClientId(row.id)) return refuse(`"${row.name}" (${row.id}) is on the never-synthetic list: a real client, whatever it is called.`, { clientId, to });
  if (!isTestClientName(row.name)) return refuse(`"${row.name}" is not a TEST client. Only a TEST fixture's email is changed here.`, { clientId, to });
  if (row.email && !isVerifiedTestDestinationEmail(row.email)) {
    return refuse(
      `"${row.name}" currently carries ${row.email}, which is not one of Jordan's inboxes. This script moves a fixture between Jordan's own inboxes; ` +
        `taking a row off somebody else's inbox is a decision for a person, not a script.`,
      { clientId, to, from: row.email },
    );
  }
  if (isNeverSyntheticAryeoCustomerId(row.aryeoCustomerId)) {
    return refuse(`"${row.name}" is linked to Aryeo customer ${row.aryeoCustomerId}, which belongs to a real "Jordan Spackman" row.`, { clientId, to, from: row.email });
  }

  const label = (v: string | null, verified: boolean) => (v ? `${v} (${verified ? "verified test destination" : "NOT a verified test destination"})` : "(none)");
  log(`Fixture: "${row.name}" (${row.id})`);
  log(`  email        ${label(row.email, isVerifiedTestDestinationEmail(row.email))}`);
  log(`  backupEmail  ${label(row.backupEmail, isVerifiedTestDestinationEmail(row.backupEmail))} — unchanged`);
  log(`  phone        ${label(row.phone, isVerifiedTestDestinationPhone(row.phone))} — unchanged${row.phone && !isVerifiedTestDestinationPhone(row.phone) ? " (the outbox floor refuses texts to it for a TEST client)" : ""}`);
  log(`  Aryeo customer ${row.aryeoCustomerId ?? "(none)"} — unchanged (this script calls no provider)`);

  if (row.email === to) {
    log(`No change: "${row.name}" already reads ${to}.`);
    return { code: 0, mode, clientId, from: row.email, to, changed: false };
  }

  // Who else is on this inbox. Informational: email-matched readers (Gmail
  // inbound, Aryeo import fallback, OpenPhone contacts) may attribute the inbox
  // to either row once two share it. The two email-matched WRITERS that copy
  // an Aryeo customer-user's fields onto the hub row — syncAryeoCustomers
  // (headshot, company, licence) and syncAryeoSocialPlans (social flag and
  // plan) — skip TEST fixtures since Sep 28 (isSyntheticClientRow), so a
  // fixture sharing a real customer's inbox takes none of that customer's data.
  const domain = to.slice(to.lastIndexOf("@") + 1);
  const target = canonicalInbox(to);
  const sameDomain = await db.client.findMany({
    where: { id: { not: row.id }, OR: [{ email: { endsWith: `@${domain}`, mode: "insensitive" } }, { backupEmail: { endsWith: `@${domain}`, mode: "insensitive" } }] },
    select: { id: true, name: true, email: true, backupEmail: true },
  });
  const sharing = sameDomain.filter((c) => canonicalInbox(c.email) === target || canonicalInbox(c.backupEmail) === target);
  if (sharing.length) {
    log(`Also on ${target} (read-only note, not changed):`);
    for (const c of sharing) {
      const kind = isNeverSyntheticClientId(c.id) ? "real, never-synthetic" : isTestClientName(c.name) ? "TEST" : "real";
      log(`  ${c.id}  "${c.name}"  [${kind}]  email=${c.email ?? "-"}  backupEmail=${c.backupEmail ?? "-"}`);
    }
    log("  Email-matched readers (Gmail inbound, the Aryeo import fallback, OpenPhone contacts) may attribute this inbox to either row.");
    log("  The Aryeo customer-user syncs (headshot/company/licence, social flag/plan) skip TEST fixtures, so this one takes nothing from a real customer on the same inbox.");
  }
  log(`Would set: Client.email ${row.email ?? "(none)"} → ${to}. Nothing else changes.`);

  if (!apply) {
    log("DRY RUN: nothing was written. Re-run with --apply.");
    return { code: 0, mode, clientId, from: row.email, to, changed: false };
  }

  // ---- 1. the backup, before the write, outside the repository -------------
  const now = opts.now ?? new Date();
  const dir = path.resolve(opts.backupDir ?? os.homedir());
  if (dir === REPO || dir.startsWith(REPO + path.sep)) return refuse(`the backup directory ${dir} is inside the repository.`, { clientId, to, from: row.email });
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `rtp-backup-${etDay(now)}-fixture-${row.id}.json`);
  if (fs.existsSync(file)) file = path.join(dir, `rtp-backup-${etDay(now)}-fixture-${row.id}-${now.getTime()}.json`);
  const backup = { format: "rtp-fixture-email/1", takenAt: now.toISOString(), script: "scripts/_ops/set-fixture-email.ts", change: { column: "email", from: row.email, to }, client: row };
  // wx: never overwrite; mode applies on create, chmod covers a permissive umask.
  fs.writeFileSync(file, JSON.stringify(backup, null, 2), { mode: 0o600, flag: "wx" });
  fs.chmodSync(file, 0o600);
  log(`backup: ${file} (0600)`);

  // ---- 2. the write and its audit row, together -------------------------
  let auditId = "";
  try {
    auditId = await db.$transaction(async (tx) => {
      // Compare-and-set on what was read: a row renamed, re-pointed or re-linked
      // since then is not the row that was checked.
      const r = await tx.client.updateMany({
        where: { id: row.id, name: row.name, email: row.email, aryeoCustomerId: row.aryeoCustomerId },
        data: { email: to },
      });
      if (r.count !== 1) throw new Error("the client changed between the read and the write");
      const a = await tx.auditLog.create({
        data: {
          actor: ACTOR,
          action: FIXTURE_EMAIL_AUDIT_ACTION,
          target: `client:${row.id}`,
          detail: `email: ${row.email ?? "null"} -> ${to} (TEST fixture "${row.name}"; backup ${file})`,
        },
        select: { id: true },
      });
      return a.id;
    });
  } catch (e) {
    return refuse(`${e instanceof Error ? e.message : String(e)}. The backup at ${file} is the unchanged row.`, { clientId, to, from: row.email, backupPath: file });
  }

  // ---- 3. read back ---------------------------------------------------------
  const after = await db.client.findUnique({ where: { id: row.id }, select: { email: true, name: true, phone: true, aryeoCustomerId: true } });
  const ok = after?.email === to && after.name === row.name && after.phone === row.phone && after.aryeoCustomerId === row.aryeoCustomerId;
  log(`${ok ? "DONE" : "READBACK MISMATCH"}: "${row.name}" email ${row.email ?? "(none)"} → ${after?.email ?? "(missing)"} · AuditLog ${auditId} · backup ${file}`);
  return { code: ok ? 0 : 1, mode, clientId, from: row.email, to, changed: true, backupPath: file, auditId };
}

/** The dry run's connection refuses writes at the database, not just in this file. */
function readOnlyDatabaseUrl(): string {
  let url = process.env.DATABASE_URL ?? "";
  if (!url) {
    for (const file of [path.resolve(process.cwd(), ".env"), path.resolve(REPO, ".env")]) {
      if (!fs.existsSync(file)) continue;
      const m = fs.readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.*)$/m);
      if (m) { url = m[1].trim().replace(/^["']|["']$/g, ""); break; }
    }
  }
  if (!url) throw new Error("DATABASE_URL not found — refusing to dry-run without the read-only guard.");
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  return u.toString();
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const backupDir = argValues(argv, "--backup-dir")[0];
  const db = apply ? new PrismaClient() : new PrismaClient({ datasourceUrl: readOnlyDatabaseUrl() });
  try {
    if (!apply) {
      // Prove the connection cannot write before reading anything.
      const refused = await db.$executeRawUnsafe("CREATE TEMP TABLE set_fixture_email_probe (x int)").then(() => false).catch(() => true);
      if (!refused) throw new Error("the dry-run connection accepted a write — refusing to continue");
    }
    return (await setFixtureEmail(db, argv, { backupDir })).code;
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
}
