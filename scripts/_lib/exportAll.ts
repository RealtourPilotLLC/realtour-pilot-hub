// ---------------------------------------------------------------------------
// EXPORT EVERY MODEL (A02-backup-coverage, Sep 28 2026).
//
// Moved out of backup-all.ts so the restore rehearsal can run the SAME export
// against the database it just rebuilt and compare the two row for row: a
// round trip through one exporter proves the rows came back, not merely that
// the counts did.
//
// Two changes from the loop it replaces:
//   - each model pages on its real primary key from the datamodel. The old
//     loop assumed a field called `id`; AppSetting's key is `key`, so it was
//     read in one unpaged findMany, and a composite key would have been too;
//   - snapshotExport runs the whole walk inside ONE repeatable-read
//     transaction. The old loop was minutes of separate findMany calls, so a
//     Project written between the Client and Project reads could land in the
//     file without its client: a consistent file was luck, not a guarantee.
//
// Reads only. The caller decides where the connection points (backup-all
// proves it read-only first; the rehearsal points it at an isolated copy).
// ---------------------------------------------------------------------------
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { delegateName, idFieldsOf, idKeyOf, tableOf, type BackupData, type DmmfModel, type Row } from "./backupFormat";

type Delegate = { findMany: (args: unknown) => Promise<Row[]> };
type Raw = { $queryRawUnsafe: <T = unknown>(sql: string, ...values: unknown[]) => Promise<T> };

export type ExportResult = {
  counts: Record<string, number>;
  data: BackupData;
  /** sha256 of the model's sorted primary keys (first 32 hex): equal hashes =
   *  the same set of rows, without comparing a single value. */
  idHash: Record<string, string>;
};

export const allModels = (): readonly DmmfModel[] => Prisma.dmmf.datamodel.models as unknown as readonly DmmfModel[];

export function idHashOf(rows: Row[], idFields: string[]): string {
  const ids = rows.map((r) => idKeyOf(r, idFields)).sort();
  return crypto.createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 32);
}

/** The first line of an error that says what went wrong (Prisma opens with a
 *  stack of "Invalid `x.findMany()` invocation" lines). Never a row value:
 *  a read error names a table or column, not data. */
function why(e: unknown): string {
  const lines = String((e as Error)?.message ?? e)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    // Source paths and stack frames say where WE were, not what went wrong.
    .filter((l) => !/^(Invalid|→|\d+ |at\s|\/|[A-Za-z]:\\)/.test(l) && !/\.(ts|js|mjs|cjs):\d+/.test(l));
  const cause = lines.find((l) => /does not exist|violates|denied|timed out|terminated|closed|Error|failed/i.test(l));
  return (cause ?? lines[0] ?? "unknown error").slice(0, 200);
}

/**
 * Every row of every model in `models`, paged on its primary key. Throws on
 * the first model that cannot be read, naming it: inside a snapshot every
 * later read would fail anyway (the transaction is aborted), and a backup
 * with a hole in it must not be written.
 */
export async function exportAll(
  db: unknown,
  models: readonly DmmfModel[] = allModels(),
  opts: { pageSize?: number; onModel?: (model: string, rows: number) => void } = {},
): Promise<ExportResult> {
  const pageSize = opts.pageSize ?? 2000;
  const out: ExportResult = { counts: {}, data: {}, idHash: {} };
  for (const m of models) {
    const d = (db as Record<string, Delegate | undefined>)[delegateName(m.name)];
    if (!d?.findMany) throw new Error(`${m.name}: no such model on this Prisma client (renamed or removed?)`);
    const ids = idFieldsOf(m);
    const rows: Row[] = [];
    try {
      if (ids.length === 1) {
        const id = ids[0];
        let cursor: unknown = undefined;
        for (;;) {
          const page = await d.findMany({ take: pageSize, orderBy: { [id]: "asc" }, ...(cursor !== undefined ? { cursor: { [id]: cursor }, skip: 1 } : {}) });
          for (const r of page) rows.push(r);
          if (page.length < pageSize) break;
          cursor = page[page.length - 1][id];
        }
      } else {
        // A composite key cannot be a cursor as simply; inside a snapshot an
        // offset is just as stable.
        for (let skip = 0; ; skip += pageSize) {
          const page = await d.findMany({ take: pageSize, skip, orderBy: ids.map((f) => ({ [f]: "asc" })) });
          for (const r of page) rows.push(r);
          if (page.length < pageSize) break;
        }
      }
    } catch (e) {
      throw new Error(`${m.name}: ${why(e)}`);
    }
    out.data[m.name] = rows;
    out.counts[m.name] = rows.length;
    out.idHash[m.name] = idHashOf(rows, ids);
    opts.onModel?.(m.name, rows.length);
  }
  return out;
}

/** Tables in the connection's schema that no model maps (an implicit
 *  many-to-many table, a hand-made table, a migrations ledger). None today;
 *  listed so one cannot be left out of a backup without anybody knowing. */
export async function unmappedTables(db: Raw, models: readonly DmmfModel[] = allModels()): Promise<{ table: string; rows: number | null }[]> {
  const mapped = new Set(models.map(tableOf));
  const tables = await db.$queryRawUnsafe<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  const out: { table: string; rows: number | null }[] = [];
  for (const { table_name } of tables) {
    if (mapped.has(table_name)) continue;
    let rows: number | null = null;
    try {
      const r = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table_name.replace(/"/g, '""')}"`);
      rows = Number(r[0]?.n ?? 0);
    } catch { /* counted as unknown, still listed */ }
    out.push({ table: table_name, rows });
  }
  return out;
}

export type SnapshotResult = ExportResult & { takenAt: string; serverVersion: string; unmappedTables: { table: string; rows: number | null }[] };

type TxClient = Raw & Record<string, unknown>;
type SnapshotCapable = {
  $transaction: <R>(fn: (tx: TxClient) => Promise<R>, options: { isolationLevel: Prisma.TransactionIsolationLevel; timeout: number; maxWait: number }) => Promise<R>;
};

/**
 * The whole export as ONE snapshot: every read inside a single REPEATABLE READ
 * transaction, so the file is the database at one instant. takenAt is that
 * instant as the server saw it (now() is the transaction's start).
 */
export async function snapshotExport(
  prisma: unknown,
  models: readonly DmmfModel[] = allModels(),
  opts: { pageSize?: number; onModel?: (model: string, rows: number) => void; timeoutMs?: number } = {},
): Promise<SnapshotResult> {
  return (prisma as SnapshotCapable).$transaction(
    async (tx) => {
      const [meta] = await tx.$queryRawUnsafe<{ now: Date; v: string }[]>(`SELECT now() AS now, current_setting('server_version') AS v`);
      const unmapped = await unmappedTables(tx, models);
      const res = await exportAll(tx, models, opts);
      return { ...res, takenAt: new Date(meta.now).toISOString(), serverVersion: String(meta.v), unmappedTables: unmapped };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: opts.timeoutMs ?? 15 * 60_000, maxWait: 30_000 },
  );
}
