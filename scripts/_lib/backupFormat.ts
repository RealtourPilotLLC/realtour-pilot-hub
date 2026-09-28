// ---------------------------------------------------------------------------
// THE BACKUP FILE, READ AND WRITTEN IN ONE PLACE (A01 / A02, Sep 28 2026).
//
// Three scripts wrote or read row-level backups, each with its own idea of the
// file: backup-all wrote `{ takenAt, models, counts, data }`, the program
// backup wrote `{ ..., tables }`, and the restore and the recovery drill read
// only `tables`, so neither could open a whole-hub backup at all (a TypeError
// on `dump.tables`). The probe knew only a file's name. This is the one
// reader and the one writer, plus the schema facts every consumer needs:
// which models exist, their id fields, their foreign keys and the "plain
// refs" Postgres does not enforce.
//
// FORMAT rtp-backup-all/2 (written by backup-all.ts): one line of header, then
// ONE ROW PER LINE under "data". The header comes first so a reader can say
// what a 200 MB file holds from its first few kilobytes, and the line-per-row
// body means neither side ever builds the whole file as one string (V8 caps a
// string near 512 MB; the 213 MB backup of Sep 25 had 2.4x headroom left).
// The file is valid JSON either way.
//
// Production data lives in these files. Nothing here prints a row value;
// readers report model names, field names and counts only. Files are written
// 0600.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { execFileSync } from "node:child_process";

export const REPO = path.resolve(__dirname, "../..");
export const BACKUP_FORMAT = "rtp-backup-all/2";

export type Row = Record<string, unknown>;
export type BackupData = Record<string, Row[]>;

export type BackupHeader = {
  format?: string;
  takenAt: string;
  commit?: string;
  schemaHash?: string;
  prismaVersion?: string;
  serverVersion?: string;
  snapshot?: string;
  /** backup-all: a count; the program backup: the model list. */
  models?: number | string[];
  counts?: Record<string, number>;
  idHash?: Record<string, string>;
  unmappedTables?: { table: string; rows: number | null }[];
  rows?: number;
};

export type HeaderRead = {
  header: BackupHeader;
  /** Which key holds the rows: `data` (backup-all) or `tables` (program backup). */
  dataKey: "data" | "tables";
  /** Model names the header itself declares (counts keys, else the models list). */
  modelNames: string[] | null;
  headerBytes: number;
};

// ---- JSON -----------------------------------------------------------------

/** What every writer passes to JSON.stringify: BigInt as text, and bytes as
 *  Postgres hex so a restore can cast them back (no model has Bytes today). */
export function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v && typeof v === "object" && (v as { type?: unknown }).type === "Buffer" && Array.isArray((v as { data?: unknown }).data)) {
    return `\\x${Buffer.from((v as { data: number[] }).data).toString("hex")}`;
  }
  return v;
}

/** Stable text for one row: keys sorted, values as the file would hold them.
 *  Two rows that restore to the same thing have the same canonical text. */
export function canonical(row: Row): string {
  const plain = JSON.parse(JSON.stringify(row, jsonReplacer)) as Row;
  return JSON.stringify(Object.keys(plain).sort().map((k) => [k, plain[k]]));
}

// ---- reading --------------------------------------------------------------

/**
 * The header without loading the rows: reads up to `maxBytes` from the start
 * and stops at the top-level `"data"` / `"tables"` key. A tiny scanner, not a
 * regex, so a pretty-printed program backup and a one-line backup-all file
 * both work and a string that happens to contain `"data":` cannot fool it.
 */
export function readBackupHeader(file: string, maxBytes = 4 * 1024 * 1024): HeaderRead {
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(64 * 1024);
    // A chunk boundary can split a multi-byte character; the decoder holds
    // the partial bytes over instead of emitting a replacement character.
    const decoder = new StringDecoder("utf8");
    let text = "";
    let pos = 0;
    let depth = 0, inString = false, escaped = false, strStart = -1, lastString = "", lastStringEnd = -1;
    let scanned = 0;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      text += decoder.write(chunk.subarray(0, n));
      for (let i = scanned; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === "\\") escaped = true;
          else if (ch === '"') { inString = false; lastString = text.slice(strStart + 1, i); lastStringEnd = i; }
          continue;
        }
        if (ch === '"') { inString = true; strStart = i; continue; }
        if (ch === "{" || ch === "[") { depth++; continue; }
        if (ch === "}" || ch === "]") { depth--; continue; }
        if (ch === ":" && depth === 1 && (lastString === "data" || lastString === "tables") && /^\s*$/.test(text.slice(lastStringEnd + 1, i))) {
          const headText = text.slice(0, strStart).replace(/,\s*$/, "") + "}";
          const header = JSON.parse(headText) as BackupHeader;
          const modelNames = header.counts ? Object.keys(header.counts) : Array.isArray(header.models) ? [...header.models] : null;
          return { header, dataKey: lastString as "data" | "tables", modelNames, headerBytes: Buffer.byteLength(headText) };
        }
      }
      scanned = text.length;
      if (pos >= maxBytes) break;
    }
    throw new Error(`no "data" or "tables" key in the first ${Math.round(Math.min(pos, maxBytes) / 1024)} KB — not a backup file`);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The whole file. Accepts `data` or the legacy `tables`. A /2 file above
 * `streamAboveBytes` is read line by line instead of as one string; any other
 * file is parsed whole (they predate the line layout).
 */
export async function readBackup(file: string, opts: { streamAboveBytes?: number } = {}): Promise<{ header: BackupHeader; data: BackupData; dataKey: "data" | "tables" }> {
  const head = readBackupHeader(file);
  const size = fs.statSync(file).size;
  if (head.header.format === BACKUP_FORMAT && size > (opts.streamAboveBytes ?? 400 * 1024 * 1024)) {
    return { header: head.header, data: await readLines(file), dataKey: "data" };
  }
  const whole = JSON.parse(fs.readFileSync(file, "utf8")) as BackupHeader & { data?: BackupData; tables?: BackupData };
  const data = whole.data ?? whole.tables;
  if (!data || typeof data !== "object") throw new Error("the file has neither `data` nor `tables`");
  const { data: _d, tables: _t, ...header } = whole;
  void _d; void _t;
  return { header, data, dataKey: whole.data ? "data" : "tables" };
}

/** The /2 body, one row per line (see writeBackupFile for the exact layout). */
async function readLines(file: string): Promise<BackupData> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const data: BackupData = {};
  let current: Row[] | null = null;
  let first = true;
  for await (const line of rl) {
    if (first) { first = false; continue; } // the header line
    const open = /^"((?:[^"\\]|\\.)+)":\[$/.exec(line);
    if (open) { current = data[JSON.parse(`"${open[1]}"`) as string] = []; continue; }
    if (line.startsWith("]")) { current = null; continue; }
    if (line.startsWith("{") || line.startsWith(",{")) {
      if (!current) throw new Error("a row outside any model — the file is damaged");
      current.push(JSON.parse(line.startsWith(",") ? line.slice(1) : line) as Row);
    }
  }
  return data;
}

// ---- writing --------------------------------------------------------------

/**
 * Write a /2 file: header on the first line, then
 *   "Model":[
 *   {row}
 *   ,{row}
 *   ],
 * and so on. Written to `<file>.partial` (mode 0600, fchmod'd in case a stale
 * partial existed) and renamed into place only when complete, so a failed
 * backup never leaves a file that looks finished.
 */
export function writeBackupFile(file: string, header: BackupHeader, data: BackupData): { bytes: number } {
  const partial = `${file}.partial`;
  const fd = fs.openSync(partial, "w", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    const { format: _format, ...rest } = header;
    void _format; // always written, and always first
    const head = JSON.stringify({ format: BACKUP_FORMAT, ...rest }, jsonReplacer);
    fs.writeSync(fd, `${head.slice(0, -1)},"data":{\n`);
    const names = Object.keys(data);
    names.forEach((name, i) => {
      fs.writeSync(fd, `${i ? ",\n" : ""}${JSON.stringify(name)}:[\n`);
      const rows = data[name];
      const BATCH = 500;
      for (let j = 0; j < rows.length; j += BATCH) {
        const lines = rows.slice(j, j + BATCH).map((r, k) => `${j + k ? "," : ""}${JSON.stringify(r, jsonReplacer)}\n`);
        fs.writeSync(fd, lines.join(""));
      }
      fs.writeSync(fd, "]");
    });
    fs.writeSync(fd, "\n}}\n");
  } catch (e) {
    fs.closeSync(fd);
    try { fs.unlinkSync(partial); } catch { /* already gone */ }
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(partial, file);
  fs.chmodSync(file, 0o600);
  return { bytes: fs.statSync(file).size };
}

/** Where the rehearsal records its verdict on a backup: beside it, 0600. */
export const evidencePathFor = (backupFile: string) => backupFile.replace(/\.json$/, "") + ".rehearsal.json";
export const isEvidenceFile = (name: string) => /\.rehearsal\.json$/.test(name);

// ---- the schema -----------------------------------------------------------

export const schemaHashOf = (text: string | Buffer) => crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
export const currentSchemaText = (repo = REPO) => fs.readFileSync(path.join(repo, "prisma/schema.prisma"), "utf8");
export const modelNamesFromSchemaText = (text: string) => [...text.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);

function git(args: string[], repo = REPO): string | null {
  try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
}
export const headCommit = (repo = REPO) => git(["rev-parse", "HEAD"], repo);
/** When prisma/schema.prisma last changed in this checkout (ISO). */
export const schemaChangedAt = (repo = REPO) => git(["log", "-1", "--format=%cI", "--", "prisma/schema.prisma"], repo);

/**
 * The schema that produced a backup, as best the repository can say: the
 * stamped commit's schema.prisma; else, for an unstamped file, the schema as
 * of the last commit before it was taken (the live schema is pushed when it
 * is committed here, so this is right to within a push). Null when neither is
 * available.
 */
export function schemaAtBackup(header: BackupHeader, repo = REPO): { text: string; basis: "commit" | "takenAt" } | null {
  if (header.commit && /^[0-9a-f]{7,40}$/i.test(header.commit)) {
    const t = git(["show", `${header.commit}:prisma/schema.prisma`], repo);
    if (t) return { text: t, basis: "commit" };
  }
  if (header.takenAt && !Number.isNaN(Date.parse(header.takenAt))) {
    const sha = git(["rev-list", "-1", `--before=${header.takenAt}`, "HEAD", "--", "prisma/schema.prisma"], repo);
    const t = sha ? git(["show", `${sha}:prisma/schema.prisma`], repo) : null;
    if (t) return { text: t, basis: "takenAt" };
  }
  return null;
}

export type SchemaComparison = {
  /** Models the backup's own schema had that the file does not hold: a hole. */
  missing: string[];
  /** Models the file holds that the current schema does not: unrestorable. */
  extra: string[];
  /** Current models the backup's schema did not have yet: restored empty. */
  addedSince: string[];
  sameSchema: boolean | null;
  basis: "commit" | "takenAt" | "current";
};

/** A backup's model set against the schema it came from and the current one. */
export function compareBackupToSchema(head: HeaderRead, currentModels: string[], repo = REPO): SchemaComparison {
  const inFile = new Set(head.modelNames ?? []);
  const now = new Set(currentModels);
  const currentHash = (() => { try { return schemaHashOf(currentSchemaText(repo)); } catch { return null; } })();
  const sameSchema = head.header.schemaHash && currentHash ? head.header.schemaHash === currentHash : null;
  // A file stamped with the current schema is judged against it outright.
  const then = sameSchema ? null : schemaAtBackup(head.header, repo);
  const thenModels = new Set(then ? modelNamesFromSchemaText(then.text) : currentModels);
  return {
    missing: [...thenModels].filter((m) => !inFile.has(m)).sort(),
    extra: [...inFile].filter((m) => !now.has(m)).sort(),
    addedSince: [...now].filter((m) => !thenModels.has(m) && !inFile.has(m)).sort(),
    sameSchema,
    basis: then?.basis ?? "current",
  };
}

// ---- DMMF -----------------------------------------------------------------

export type DmmfField = {
  name: string; kind: string; type: string; isId: boolean; isList: boolean; isRequired: boolean;
  dbName?: string | null; relationName?: string | null;
  relationFromFields?: readonly string[] | null; relationToFields?: readonly string[] | null;
};
export type DmmfModel = { name: string; dbName?: string | null; fields: readonly DmmfField[]; primaryKey?: { fields: readonly string[] } | null };

export const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);
export const tableOf = (m: DmmfModel) => m.dbName || m.name;
export const columnOf = (m: DmmfModel, field: string) => m.fields.find((f) => f.name === field)?.dbName || field;

/** A model's primary key fields: its @id (AppSetting's is `key`), else @@id. */
export function idFieldsOf(m: DmmfModel): string[] {
  const single = m.fields.find((f) => f.isId);
  if (single) return [single.name];
  if (m.primaryKey?.fields?.length) return [...m.primaryKey.fields];
  throw new Error(`${m.name} has no primary key in the datamodel`);
}

export const idKeyOf = (row: Row, idFields: string[]) => idFields.map((f) => String(row[f])).join("\u0000");

export type FkRelation = { name: string; child: string; fields: string[]; parent: string; parentKey: string[]; required: boolean };

/** Every foreign key Postgres enforces, from the datamodel (49 today). */
export function fkRelations(models: readonly DmmfModel[]): FkRelation[] {
  const out: FkRelation[] = [];
  for (const m of models) {
    for (const f of m.fields) {
      if (f.kind !== "object" || !f.relationFromFields?.length) continue;
      out.push({
        name: `${m.name}.${f.relationFromFields.join("+")} -> ${f.type}`,
        child: m.name,
        fields: [...f.relationFromFields],
        parent: f.type,
        parentKey: [...(f.relationToFields ?? [])],
        required: f.isRequired,
      });
    }
  }
  return out;
}

/**
 * THE REFERENCES POSTGRES DOES NOT ENFORCE (moved here from
 * restore-content-program.ts, Sep 28 2026, unchanged in rule).
 *
 * The Content Program is deliberately decoupled from the operational core:
 * over 170 of its columns are "plain refs" — an id in a String column with no
 * foreign key behind it. The map is read from the schema's own documented
 * convention — `field String // -> Model` — rather than hand-maintained, so a
 * new plain ref is covered the day somebody writes that comment.
 */
export function plainRefs(schemaText: string): Map<string, Map<string, string>> {
  const models = new Set(modelNamesFromSchemaText(schemaText));
  const byModel = new Map<string, Map<string, string>>();
  let current: string | null = null;
  for (const line of schemaText.split("\n")) {
    const open = /^model\s+(\w+)\s*\{/.exec(line);
    if (open) { current = open[1]; continue; }
    if (/^\}/.test(line)) { current = null; continue; }
    if (!current) continue;
    const m = /^\s*(\w+)\s+\S+.*\/\/\s*->\s*(\w+)/.exec(line);
    if (!m) continue;
    const [, field, target] = m;
    // "// -> the version Jordan approved" is prose, not a model name.
    if (!models.has(target)) continue;
    if (!byModel.has(current)) byModel.set(current, new Map());
    byModel.get(current)!.set(field, target);
  }
  return byModel;
}

/** DateTime fields per model, so a restore revives exactly those and never a
 *  text column that merely looks like a timestamp. */
export function dateFieldsOf(m: DmmfModel): Set<string> {
  return new Set(m.fields.filter((f) => f.kind === "scalar" && f.type === "DateTime").map((f) => f.name));
}

// ---- the probe's view of the backups on this machine ------------------------

export type BackupFact = { fact: string; labels: ("OK" | "WARN" | "UNKNOWN")[]; evidence: string };

/** A recovery-drill subset written beside its backup
 *  (`<backup>.json.children-only.json`) — never a backup of its own. */
export const isDerivedSubsetFile = (name: string) => /\.json\.[^/]+\.json$/.test(name);

/**
 * What the config probe says about the row-level backups in `dir`: the
 * newest WHOLE-HUB one's model set against the schema it came from and the
 * current schema, whether the schema has changed since it was taken, its file
 * mode, and whether a restore rehearsal has been recorded for it. Every
 * backup's mode is checked (they hold client data). Headers only; no row is
 * read.
 *
 * THE NEWEST WHOLE-HUB BACKUP, NOT THE NEWEST FILE (review, Sep 28). The team
 * writes targeted snapshots under the same prefix (a few rows kept before a
 * one-off fix: "…-delivered-job-notes.json"), and a recovery drill leaves
 * subsets beside a backup when it fails. Sorted by mtime, the newest of those
 * won: its header was unreadable, so the coverage, schema and rehearsal facts
 * of the real 209 MB backup were never reported — or, for a subset, every
 * model read as MISSING. A whole-hub backup is backup-all's file: rows under
 * a top-level `data` key (the program backup's `tables` is a subset by
 * design). The newer files passed over are named, so nothing is hidden.
 */
export function backupFacts(dir: string, currentModels: string[], opts: { repo?: string; now?: Date } = {}): BackupFact[] {
  const repo = opts.repo ?? REPO;
  const now = opts.now ?? new Date();
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir)
        .filter((f) => /^rtp-backup-.*\.json$/.test(f) && !isEvidenceFile(f))
        .map((f) => ({ f, full: path.join(dir, f), st: fs.statSync(path.join(dir, f)) }))
        .sort((a, b) => b.st.mtime.getTime() - a.st.mtime.getTime())
    : [];
  if (!files.length) return [{ fact: "newest row-level backup", labels: ["WARN"], evidence: `none found in ${dir}` }];
  const out: BackupFact[] = [];
  const hours = (d: Date) => `${Math.round((now.getTime() - d.getTime()) / 36e5)}h ago`;
  let newest: (typeof files)[number] | null = null;
  let head: HeaderRead | null = null;
  const passedOver: string[] = [];
  for (const x of files) {
    if (isDerivedSubsetFile(x.f)) { passedOver.push(`${x.f} (a recovery-drill subset)`); continue; }
    let h: HeaderRead | null = null;
    try { h = readBackupHeader(x.full); } catch { h = null; }
    if (h?.dataKey === "data") { newest = x; head = h; break; }
    passedOver.push(`${x.f} (${h ? "a program backup, not the whole hub" : "a targeted snapshot, not a backup file"})`);
  }
  if (passedOver.length) {
    out.push({
      fact: "newer rtp-backup files that are not whole-hub backups",
      labels: ["OK"],
      evidence: `${passedOver.length}: ${passedOver.slice(0, 6).join(", ")}${passedOver.length > 6 ? ", …" : ""}`,
    });
  }
  if (!newest || !head) {
    out.push({ fact: "newest row-level backup", labels: ["WARN"], evidence: `no whole-hub backup (backup-all's file) in ${dir}` });
  }
  if (newest && head) {
    const cmp = compareBackupToSchema(head, currentModels, repo);
    const taken = new Date(head.header.takenAt);
    out.push({
      fact: "newest row-level backup",
      labels: ["OK"],
      evidence: `${newest.f} · taken ${hours(taken)} · ${head.header.format ?? "legacy format"} · ${head.modelNames?.length ?? "?"} models in the header · schema has ${currentModels.length}${head.header.serverVersion ? ` · server ${head.header.serverVersion}` : ""}`,
    });
    const problems = [
      cmp.missing.length ? `MISSING from the file: ${cmp.missing.join(", ")}` : "",
      cmp.extra.length ? `in the file but not in the schema: ${cmp.extra.join(", ")}` : "",
    ].filter(Boolean);
    out.push({
      fact: "backup covers its schema's models",
      labels: problems.length ? ["WARN"] : ["OK"],
      evidence: problems.join(" · ") || `all present (judged against the ${cmp.basis === "current" ? "current" : cmp.basis === "commit" ? "stamped commit's" : "then-current"} schema)`,
    });
    const changedAt = schemaChangedAt(repo);
    const stale = changedAt ? new Date(changedAt).getTime() > taken.getTime() : null;
    out.push({
      fact: "backup is newer than the schema",
      labels: stale === null ? ["UNKNOWN"] : stale || cmp.addedSince.length ? ["WARN"] : ["OK"],
      evidence: stale === null
        ? "cannot read the schema's history here"
        : stale
          ? `schema.prisma changed ${changedAt} — after this backup${cmp.addedSince.length ? `; models it cannot hold: ${cmp.addedSince.join(", ")}` : ""}. Take a fresh backup before the next schema push.`
          : `schema last changed ${changedAt}`,
    });
    const ev = evidencePathFor(newest.full);
    let rehearsal = "no restore rehearsal recorded (npx tsx scripts/restore-rehearsal.ts <this file>)";
    let rehearsalOk: boolean | null = null;
    if (fs.existsSync(ev)) {
      try {
        const e = JSON.parse(fs.readFileSync(ev, "utf8")) as { verdict?: string; finishedAt?: string; engine?: string; failures?: number };
        rehearsalOk = e.verdict === "PASS";
        rehearsal = `rehearsal ${e.verdict ?? "?"} on ${e.engine ?? "?"} at ${e.finishedAt ?? "?"}${e.failures ? ` · ${e.failures} failure line(s)` : ""}`;
      } catch { rehearsal = "rehearsal evidence file unreadable"; }
    }
    out.push({ fact: "restore rehearsal for the newest backup", labels: rehearsalOk ? ["OK"] : ["WARN"], evidence: rehearsal });
  }
  const open = files.filter((x) => (x.st.mode & 0o777) !== 0o600);
  out.push({
    fact: "backup files are private (0600)",
    labels: open.length ? ["WARN"] : ["OK"],
    evidence: open.length
      ? `${open.length} of ${files.length} readable by others: ${open.map((x) => `${x.f} (${(x.st.mode & 0o777).toString(8)})`).join(", ")} — chmod 600 ~/rtp-backup-*.json`
      : `all ${files.length} are 0600`,
  });
  return out;
}
