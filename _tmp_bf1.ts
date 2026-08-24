import { prisma } from "./src/lib/prisma";
import { readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = "/Users/jordanspackman/Downloads/Social Content Scripts, Strategy Calls, and Discovery Calls";

// Folder → client-name hints for the fuzzy match.
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const MONTH_NUM: Record<string, number> = { january:1,jan:1,february:2,feb:2,march:3,mar:3,april:4,apr:4,may:5,june:6,jun:6,july:7,jul:7,august:8,aug:8,september:9,sep:9,sept:9,october:10,oct:10,november:11,nov:11,december:12,dec:12 };

type Doc = { folder: string; file: string; kind: string; monthKey: string | null; note?: string };

function classify(folder: string, file: string): Doc {
  const f = file.toLowerCase();
  let kind = "unknown"; let monthKey: string | null = null; let note: string | undefined;

  // Gemini call notes: date in name "2026_08_07"
  const gem = f.match(/(\d{4})_(\d{2})_(\d{2})/);
  if (/notes by gemini/.test(f)) {
    kind = /discovery/.test(f) ? "discovery_call" : "strategy_call";
    if (gem) monthKey = `${gem[1]}-${gem[2]}`;
    return { folder, file, kind, monthKey };
  }
  // Month + year from name for the rest
  const my = f.match(new RegExp(`(${MONTHS})[a-z]*[\\s_.-]*(\\d{4})`)) || f.match(new RegExp(`(\\d{4})[\\s_.-]*(${MONTHS})`));
  if (my) {
    const a = my[1], b = my[2];
    const mo = MONTH_NUM[a] ?? MONTH_NUM[b];
    const yr = /^\d{4}$/.test(a) ? a : b;
    if (mo && yr) monthKey = `${yr}-${String(mo).padStart(2, "0")}`;
  } else {
    const mOnly = f.match(new RegExp(`\\b(${MONTHS})[a-z]*\\b`));
    if (mOnly && MONTH_NUM[mOnly[1]]) { monthKey = `2026-${String(MONTH_NUM[mOnly[1]]).padStart(2, "0")}`; note = "year assumed 2026"; }
  }

  if (/video topics|topics \[|topics\.|funny topics/.test(f)) kind = "topics";
  else if (/content strategy/.test(f) && !/hooks/.test(f)) kind = "strategy";
  else if (/scripts?|social content|reel scripts|hooks/.test(f)) kind = "scripts";
  if (/videos shot/.test(f)) note = (note ? note + "; " : "") + "marked Videos Shot";
  return { folder, file, kind, monthKey, note };
}

async function main() {
  const clients = await prisma.client.findMany({ select: { id: true, name: true, socialClient: true } });
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

  const folders = readdirSync(ROOT).filter((d) => !d.startsWith(".") && statSync(join(ROOT, d)).isDirectory());
  const manifest: { folder: string; clientMatch: { id: string; name: string; social: boolean } | null; docs: Doc[] }[] = [];

  for (const folder of folders) {
    // Fuzzy client match: exact contains either way, then first+last token hits.
    const fn = norm(folder).replace(/ team$/, "").replace(/^the /, "");
    const tokens = fn.split(" ");
    let match = clients.find((c) => norm(c.name) === fn)
      ?? clients.find((c) => norm(c.name).includes(fn) || fn.includes(norm(c.name)))
      ?? clients.find((c) => tokens.length > 1 && tokens.every((t) => norm(c.name).includes(t)))
      ?? clients.find((c) => tokens.length === 1 && norm(c.name).split(" ")[0] === tokens[0])
      ?? null;
    // Special folders
    if (!match && /achberger/i.test(folder)) match = clients.find((c) => /achberger/i.test(c.name)) ?? null;
    if (!match && /mercer/i.test(folder)) match = clients.find((c) => /gary mercer/i.test(c.name)) ?? null;
    if (!match && /vra/i.test(folder)) match = clients.find((c) => /erica wright/i.test(c.name)) ?? null;

    const files = readdirSync(join(ROOT, folder)).filter((x) => !x.startsWith(".") && /\.(pdf|docx|txt|md)$/i.test(x));
    const docs = files.map((x) => classify(folder, x));
    manifest.push({ folder, clientMatch: match ? { id: match.id, name: match.name, social: match.socialClient } : null, docs });
  }

  for (const m of manifest.sort((a, b) => a.folder.localeCompare(b.folder))) {
    console.log(`\n${m.folder} → ${m.clientMatch ? `${m.clientMatch.name}${m.clientMatch.social ? " [ACTIVE]" : ""}` : "NO CLIENT — will create"}`);
    const counts = new Map<string, number>();
    for (const d of m.docs) counts.set(d.kind, (counts.get(d.kind) ?? 0) + 1);
    console.log("  " + [...counts.entries()].map(([k, v]) => `${k}:${v}`).join("  "));
    for (const d of m.docs.filter((x) => x.kind === "unknown" || !x.monthKey && x.kind !== "strategy" && x.kind !== "topics"))
      console.log(`  ?? ${d.kind} no-month: ${d.file}`);
  }
  writeFileSync("/private/tmp/claude-501/-Users-jordanspackman-Realtour-Pilot-POT-Dashboard/95b4d60d-bf2f-468b-a14f-fa55d05415af/scratchpad/backfill-manifest.json", JSON.stringify(manifest, null, 1));
  console.log("\nmanifest written");
}
main().finally(() => prisma.$disconnect());
