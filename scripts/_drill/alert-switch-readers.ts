// ---------------------------------------------------------------------------
// DRILL (static): EVERY INTERNAL-ALERT SWITCH IS READ BY SOMETHING
// (unified handoff item "9-inert-alert-switches", §11 effective controls).
//
//   cd "/Users/jordanspackman/Realtour Pilot POT Dashboard" && \
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs \
//     scripts/_drill/alert-switch-readers.ts
//
// Settings → Internal alerts drew six toggles; until Sep 26 2026 two of them —
// "Raw video missing" and "Kyle's Slack digests" — were read by nothing, so
// flipping them changed nothing while the card said it did. This fails when
// any key of InternalAlertRules (src/lib/settings.ts):
//   · has no reader outside the settings store, its actions and its card —
//     a module that calls internalAlertRules() and uses the key;
//   · has no "Read by" entry on the card (ALERT_SWITCH_READERS in
//     src/components/settings/OperatingRules.tsx), or the entry names a file
//     that no longer reads it (directly, or through a function a reader
//     exports — commsBoard's 4 o'clock check reads kyleDigests through
//     notify.ts digestGate).
// It also pins the OLD answer: at 17df024 the two switches had no reader.
//
// Static on purpose: it reads source text and git objects, opens no database
// and calls nothing. (DRILL_PORT/5782 is reserved for it but never bound.)
// The behaviour of the two switches is driven in b5-notify-schedule.ts §5.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeChecker } from "./_harness";

void Number(process.env.DRILL_PORT ?? 5782); // reserved; a static drill binds nothing
const BASE = "17df024";
const REPO = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
/** Code without comments — a key named in a comment is not a reader. Only `//`
 *  at a line start or after whitespace is a comment (a URL's `//` is not). */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/** The top-level keys of `export type InternalAlertRules = { … };`. */
function alertKeys(settingsSrc: string): string[] {
  const start = settingsSrc.indexOf("export type InternalAlertRules = {");
  if (start < 0) throw new Error("InternalAlertRules not found in settings.ts");
  const body = code(settingsSrc.slice(start + "export type InternalAlertRules = ".length));
  const keys: string[] = [];
  let depth = 0;
  let depthAtLineStart = 0;
  let line = "";
  for (const ch of body) {
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
    if (ch === "\n") {
      const m = /^\s*(\w+)\s*:/.exec(line);
      if (m && depthAtLineStart === 1) keys.push(m[1]);
      line = "";
      depthAtLineStart = depth;
      continue;
    }
    line += ch;
  }
  return keys;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

const NOT_READERS = new Set(["src/lib/settings.ts", "src/components/settings/OperatingRules.tsx", "src/app/settings/actions.ts"]);
const usesKey = (src: string, key: string) => new RegExp(`\\.${key}\\b`).test(src);

/** Exported functions in `src` whose own body uses `.key` — the helpers another
 *  file may read a switch THROUGH. */
function gateFunctions(src: string, key: string): string[] {
  const names: string[] = [];
  const re = /export\s+(?:async\s+)?function\s+(\w+)/g;
  const marks = [...src.matchAll(re)].map((m) => ({ name: m[1], at: m.index ?? 0 }));
  marks.forEach((m, i) => {
    const body = src.slice(m.at, i + 1 < marks.length ? marks[i + 1].at : src.length);
    if (usesKey(body, key)) names.push(m.name);
  });
  return names;
}

async function main() {
  const c = makeChecker();
  const keys = alertKeys(read("src/lib/settings.ts"));
  c.head("1 · the switches");
  c.ok("InternalAlertRules parses into its six keys", keys.length === 6, keys.join(", "));

  const files = walk("src").filter((f) => !NOT_READERS.has(f));
  const texts = new Map(files.map((f) => [f, code(read(f))]));
  const readersOf = (key: string) => files.filter((f) => {
    const t = texts.get(f)!;
    return t.includes("internalAlertRules(") && usesKey(t, key);
  });

  c.head("2 · every switch has a reader outside the settings store and its card");
  for (const key of keys) {
    const r = readersOf(key);
    c.ok(`${key} is read by ${r.length ? r.join(", ") : "NOTHING"}`, r.length > 0);
  }

  c.head("3 · the card's \"Read by\" lines name files that really read the switch");
  const card = read("src/components/settings/OperatingRules.tsx");
  const mapStart = card.indexOf("const ALERT_SWITCH_READERS");
  c.ok("the card carries ALERT_SWITCH_READERS", mapStart >= 0);
  const mapText = card.slice(mapStart, card.indexOf("};", mapStart));
  const entries = new Map<string, { words: string; files: string[] }>();
  for (const m of mapText.matchAll(/^\s*(\w+): \{ words: "([^"]+)", files: \[([^\]]*)\] \}/gm)) {
    entries.set(m[1], { words: m[2], files: [...m[3].matchAll(/"([^"]+)"/g)].map((x) => x[1]) });
  }
  c.ok("…with an entry for every switch and none for a switch that does not exist",
    keys.every((k) => entries.has(k)) && [...entries.keys()].every((k) => keys.includes(k)),
    `card: ${[...entries.keys()].join(", ")}`);
  c.ok("…and the card renders a Read-by line for each", keys.every((k) => card.includes(`<ReadBy k="${k}" />`)), keys.filter((k) => !card.includes(`<ReadBy k="${k}" />`)).join(", "));
  for (const [key, e] of entries) {
    for (const f of e.files) {
      const t = texts.get(f) ?? (fs.existsSync(path.join(REPO, f)) ? code(read(f)) : null);
      if (t === null) {
        c.ok(`${key}: ${f} exists`, false);
        continue;
      }
      const through = readersOf(key).flatMap((r) => gateFunctions(texts.get(r)!, key)).filter((fn) => t.includes(`${fn}(`));
      c.ok(`${key}: ${f} reads it${through.length ? ` (through ${through.join(", ")})` : ""}`, usesKey(t, key) || through.length > 0);
    }
  }

  c.head(`4 · the OLD answer (${BASE}): two switches were read by nothing`);
  const oldFiles = execFileSync("git", ["grep", "-l", "internalAlertRules(", BASE, "--", "src"], { cwd: REPO, encoding: "utf8" })
    .split("\n").filter(Boolean).map((l) => l.slice(BASE.length + 1))
    .filter((f) => !NOT_READERS.has(f));
  const oldCode = (f: string) => code(execFileSync("git", ["show", `${BASE}:${f}`], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const oldReaders = (key: string) => oldFiles.filter((f) => usesKey(oldCode(f), key));
  c.ok("old: rawVideoMissing had no reader", oldReaders("rawVideoMissing").length === 0, oldReaders("rawVideoMissing").join(", "));
  c.ok("old: kyleDigests had no reader", oldReaders("kyleDigests").length === 0, oldReaders("kyleDigests").join(", "));
  c.ok("old: the other four did (the card was half true)", ["uploadReminder", "uploadChaser", "photosUndelivered", "coverage"].every((k) => oldReaders(k).length > 0));

  c.summary();
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
