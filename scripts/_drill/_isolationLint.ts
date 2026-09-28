// ---------------------------------------------------------------------------
// THE DRILL-SOURCE LINT (R06, Sep 28 2026) — a HEURISTIC, not the control.
//
// harness-selftest §H used to read every drill's text and call that proof of
// isolation ("no file in scripts/_drill/ can reach a database it did not
// create"). It could not be: comments were not stripped, so a comment saying
// `bootDrillDb(` satisfied it, and a drill that reached Prisma through an app
// import (notify → @/lib/prisma) was not even counted as touching a database.
// The control is now the runner boundary (_isolation.cjs), which refuses the
// connection itself, proven by `npm run drills:boundary`.
//
// What is left for a text scan is to catch the PRODUCTION SHAPES early — the
// things only a script meant for the live database does — reading CODE only
// (comments dropped; string, template and regex literals opaque, so a test's
// sample source or a message is not mistaken for what the drill does):
//   · readDatabaseUrl() / pinReadOnlyDatabaseUrl() (scripts/_lib/dbGuard.ts:
//     the .env's DATABASE_URL, the read-only live-probe pattern);
//   · dotenv (loading a .env on purpose);
//   · an import from scripts/_live/ or scripts/_recon/ in a drill that boots
//     no database of its own. (a56 and cp15 boot one and then import the
//     cp15 probe's pure formatter; that is reported, not failed.)
// Everything else it only REPORTS: a drill that reaches app code without
// booting a database runs on the sentinel (any query is refused), and one
// that assigns a non-loopback DATABASE_URL literal is refused at runtime too.
// ---------------------------------------------------------------------------

type Scan = { skeleton: string; literals: string[] };

/** Where a `/` starts a regex literal rather than a division. */
function regexMayStart(out: string): boolean {
  const before = out.replace(/\s+$/, "");
  if (!before) return true;
  if (/(^|[^\w$])(return|typeof|case|in|of|new|delete|void|throw|yield|await)$/.test(before)) return true;
  return /[(,=:[!&|?{};+\-*%<>~^]$/.test(before);
}

/**
 * One pass over the source. `keep` decides what a literal leaves behind:
 * itself (stripComments) or an opaque placeholder `"#n"` / `/#n/` whose text
 * is kept in `literals[n]` (the skeleton the rules read).
 */
function scan(src: string, keep: boolean): Scan {
  let out = "";
  const literals: string[] = [];
  const emit = (text: string, quote: string) => {
    if (keep) { out += text; return; }
    literals.push(text.slice(1, -1));
    out += `${quote}#${literals.length - 1}${quote}`;
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (ch === "/" && regexMayStart(out)) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j++;
      }
      if (j < n && src[j] === "/") {
        emit(src.slice(i, j + 1), "/");
        i = j + 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n && src[j] !== ch) {
        if (src[j] === "\\") { j += 2; continue; }
        if (ch !== "`" && src[j] === "\n") break; // unterminated: stop at the line end
        j++;
      }
      emit(src.slice(i, Math.min(j + 1, n)), ch === "`" ? '"' : ch);
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return { skeleton: out, literals };
}

/** Source with // and /* *\/ comments removed; strings, template literals and
 *  regex literals are kept intact (a URL's "//" is not a comment, and neither
 *  is a quote inside a regex a string). */
export function stripComments(src: string): string {
  return scan(src, true).skeleton;
}

export type DrillSourceShape = {
  /** Production shapes: the lint FAILS on any of these. */
  production: string[];
  /** Reported only: the runtime boundary is what stops them. */
  notes: string[];
};

const BOOTS = /\b(bootDrillDb|bootDemoDb|attachDrillChild|bootRealPostgres)\s*\(|\bPGlite\.create\s*\(/;

export function drillSourceShape(src: string): DrillSourceShape {
  const { skeleton, literals } = scan(src, false);
  const lit = (m: string) => literals[Number(m)] ?? "";
  // Module specifiers: the literal right after `from`, `import(` or `require(`.
  const specifiers = [...skeleton.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'/]#(\d+)["'/]/gm)].map((m) => lit(m[1]));
  const boots = BOOTS.test(skeleton);
  const production: string[] = [];
  const notes: string[] = [];
  if (/\b(readDatabaseUrl|pinReadOnlyDatabaseUrl)\s*\(/.test(skeleton)) {
    production.push("reads the .env DATABASE_URL (readDatabaseUrl/pinReadOnlyDatabaseUrl) — a live-probe shape; it belongs in scripts/_live/");
  }
  if (specifiers.some((s) => s === "dotenv" || s === "dotenv/config")) production.push("loads a .env with dotenv");
  const probes = specifiers.filter((s) => /(^|\/)_(live|recon)\//.test(s));
  if (probes.length && !boots) production.push(`imports ${probes.join(", ")} and boots no database of its own`);
  else if (probes.length) notes.push(`imports ${probes.join(", ")} (after booting its own database)`);
  const appCode = specifiers.some((s) => s.startsWith("@/") || /^(\.\.\/)+src\//.test(s) || s === "@prisma/client") || /\bPrismaClient\b/.test(skeleton);
  if (appCode && !boots) notes.push("reaches app code without booting a database — runs on the sentinel; any query is refused");
  for (const m of skeleton.matchAll(/process\.env\.(DATABASE_URL|DIRECT_URL)\s*=\s*["']#(\d+)["']/g)) {
    const value = lit(m[2]).replace(/\$\{[^}]*\}/g, "0"); // a template's ${PORT}
    if (!/^postgres(ql)?:\/\//.test(value)) continue;
    let host = "";
    try { host = new URL(value).hostname; } catch { host = "an unparsable URL"; }
    if (host !== "127.0.0.1") notes.push(`sets ${m[1]} to a non-loopback literal (${host}) — refused at runtime by the boundary`);
  }
  return { production, notes };
}
