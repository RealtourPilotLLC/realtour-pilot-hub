// ---------------------------------------------------------------------------
// STRATEGY REFERENCE MANIFEST (A08, unified handoff Sep 25 2026).
//
//   npx tsx scripts/strategy-reference-manifest.ts            # the reference set in ~/Downloads
//   npx tsx scripts/strategy-reference-manifest.ts --dir <d>  # the same file names, another folder
//   npx tsx scripts/strategy-reference-manifest.ts --check    # compare, don't write (exit 1 on drift)
//
// The handoff asks for "the repository's verified reference manifest" — and
// there was none in the repository: the Sep 16 one was a session scratchpad
// file that no longer exists. The four real strategies Jordan named (Arielle,
// Kristin, Mike Flatley, Rick) are in ~/Downloads. This reads them the SAME
// way an upload does (lib/documentText — pdf-parse / mammoth), runs the SAME
// parser and validator the hub runs on an import, and writes
// docs/strategy-reference-manifest.md: per file its name, size, sha256,
// structure version, the ordered section headings, the sub-headings in order,
// the field labels present, the pillar count and whether it defines its own
// framework.
//
// STRUCTURE ONLY. No client prose enters git: pillar names are replaced by
// "<pillar name>", titles are not recorded, and no field VALUE is written.
// The file names already name the clients (as they do in the hub's code).
//
// Local files only — no database, no network. Deterministic: no timestamps,
// files in a fixed order, so two runs over the same files write the same
// bytes (--check proves it).
// ---------------------------------------------------------------------------
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { extractDocumentText } from "@/lib/documentText";
import { parseStrategyDocument, detectStructureVersion, validateStrategyStructure, type ParsedStrategy } from "@/lib/contentPolicy";

const REPO = path.resolve(__dirname, "..");
const OUT = path.join(REPO, "docs", "strategy-reference-manifest.md");

/** The reference set, in a fixed order: the four clients the handoff names, every format on file. */
export const REFERENCE_FILES: { client: string; file: string }[] = [
  { client: "Arielle Roemer", file: "Arielle Roemer Team 2026 Content Strategy - Final.pdf" },
  { client: "Arielle Roemer", file: "Arielle_Roemer_Team_2026_Content_Strategy.docx" },
  { client: "Kristin Ciarmella", file: "Kristin Ciarmella 2026 Content Strategy.pdf" },
  { client: "Kristin Ciarmella", file: "Kristin_Ciarmella_2026_Content_Strategy.docx" },
  { client: "Mike Flatley", file: "Mike Flatley 2026 Content Strategy.pdf" },
  { client: "Mike Flatley", file: "Mike_Flatley_2026_Content_Strategy.docx" },
  { client: "Rick Schultz", file: "Rick Schultz - 2026 Social Content Strategy.pdf" },
];

export type ManifestEntry = {
  client: string; file: string; bytes: number; sha256: string;
  structureVersion: string; sections: string[]; subheadings: string[]; fieldLabels: string[];
  pillarCount: number; framework: "document" | "policy default"; missingFromTemplate: string[];
};

/** Sub-headings in document order, with every client-specific name taken out. */
export function subheadingsOf(doc: ParsedStrategy): string[] {
  const out: string[] = [];
  if (doc.targetAudience.present) out.push("Target Audience");
  for (const p of doc.contentPillars.pillars) out.push(`Pillar ${p.number ?? "?"}: <pillar name>`);
  for (const part of doc.framework?.parts ?? []) out.push(part.heading.replace(/\s+/g, " ").trim());
  if (doc.captionCtaExamples) out.push(doc.captionCtaExamples.heading.replace(/:$/, "").trim());
  if (doc.strategicDirection) out.push(doc.strategicDirection.heading.replace(/:$/, "").trim());
  return out;
}

/** The labels present (never their values), in template order, then pillar-level labels. */
export function labelsOf(doc: ParsedStrategy): string[] {
  const out: string[] = [];
  const bo = doc.brandOverview, ta = doc.targetAudience;
  if (bo.coreValues) out.push("Core Values");
  if (bo.brandMessage) out.push("Brand Message");
  if (bo.shortBrandStatement) out.push("Short Brand Statement");
  if (bo.brandVoice) out.push("Brand Voice");
  if (ta.primaryServiceAreas) out.push("Primary service areas");
  if (ta.pricePositioning) out.push("Price positioning");
  if (ta.primaryClientTypes) out.push("Primary client types");
  if (ta.longTermPositioningGoal) out.push("Long-term positioning goal");
  const pillars = doc.contentPillars.pillars;
  if (pillars.some((p) => p.purpose)) out.push("Pillar · Purpose");
  if (pillars.some((p) => p.focusAreas)) out.push("Pillar · Focus Areas");
  if (pillars.some((p) => p.contentApproach)) out.push("Pillar · Content Approach");
  return out;
}

export async function manifestEntries(dir: string): Promise<{ entries: ManifestEntry[]; missing: string[] }> {
  const entries: ManifestEntry[] = [];
  const missing: string[] = [];
  for (const ref of REFERENCE_FILES) {
    const full = path.join(dir, ref.file);
    if (!fs.existsSync(full)) { missing.push(ref.file); continue; }
    const bytes = fs.readFileSync(full);
    const ex = await extractDocumentText(bytes, ref.file);
    if (!ex.ok) throw new Error(`${ref.file}: ${ex.message}`);
    const doc = parseStrategyDocument(ex.text);
    const v = validateStrategyStructure(doc);
    entries.push({
      client: ref.client, file: ref.file, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
      structureVersion: detectStructureVersion(doc),
      // Numbered section headings as the parser read them (a pillar-named section would carry a name — none of the reference set has one).
      sections: doc.sections.map((s) => s.heading.replace(/\s+/g, " ").trim()),
      subheadings: subheadingsOf(doc),
      fieldLabels: labelsOf(doc),
      pillarCount: v.pillarCount,
      framework: v.frameworkSource,
      missingFromTemplate: v.missing,
    });
  }
  return { entries, missing };
}

export function renderManifest(entries: ManifestEntry[], missing: string[]): string {
  const lines: string[] = [
    "# Strategy reference manifest",
    "",
    "Generated by `scripts/strategy-reference-manifest.ts` from the reference strategies in `~/Downloads`, read the same way an upload is read (`src/lib/documentText.ts`) and parsed by the hub's own parser (`parseStrategyDocument` / `validateStrategyStructure`). Structure only: no field values, no titles, pillar names redacted. Re-run it after a reference file changes; `--check` fails when this file no longer matches the files.",
    "",
    "What it is for (A08): a strategy the hub drafts from a discovery call is checked against the ARIELLE entry's section and sub-heading sequence (`scripts/_drill/b2-discovery-strategy.ts`). Rick's document defines no framework (structure S2); the hub's policy framework applies to it and the document is never rewritten.",
    "",
    "| Client | File | Structure | Sections | Pillars | Framework | sha256 (first 12) |",
    "|---|---|---|---|---|---|---|",
    ...entries.map((e) => `| ${e.client} | ${e.file} | ${e.structureVersion} | ${e.sections.length} | ${e.pillarCount} | ${e.framework} | \`${e.sha256.slice(0, 12)}\` |`),
    "",
  ];
  if (missing.length) lines.push(`Not found when this was generated: ${missing.map((m) => `\`${m}\``).join(", ")}.`, "");
  for (const e of entries) {
    lines.push(
      `## ${e.client} — ${e.file}`,
      "",
      `- Size: ${e.bytes} bytes · sha256 \`${e.sha256}\``,
      `- Structure: ${e.structureVersion} · ${e.pillarCount} pillars · framework: ${e.framework}`,
      `- Sections, in order: ${e.sections.map((s) => `“${s}”`).join(" → ") || "(none found)"}`,
      `- Sub-headings, in order: ${e.subheadings.map((s) => `“${s}”`).join(" → ") || "(none)"}`,
      `- Field labels present: ${e.fieldLabels.join(", ") || "(none)"}`,
      `- Template items it lacks: ${e.missingFromTemplate.join(", ") || "(none)"}`,
      "",
    );
  }
  lines.push("## Machine-readable", "", "```json", JSON.stringify(entries, null, 1), "```", "");
  return lines.join("\n");
}

/** The JSON block of a manifest file, for the drill. */
export function readManifestEntries(markdown: string): ManifestEntry[] {
  const m = /```json\n([\s\S]*?)\n```/.exec(markdown);
  return m ? (JSON.parse(m[1]) as ManifestEntry[]) : [];
}

async function main() {
  const args = process.argv.slice(2);
  const dirAt = args.indexOf("--dir");
  const dir = dirAt >= 0 && args[dirAt + 1] ? path.resolve(args[dirAt + 1]) : path.join(os.homedir(), "Downloads");
  const { entries, missing } = await manifestEntries(dir);
  const text = renderManifest(entries, missing);
  if (args.includes("--check")) {
    const on = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (on !== text) { console.error("docs/strategy-reference-manifest.md does NOT match the reference files — re-run without --check."); process.exit(1); }
    console.log(`manifest matches the ${entries.length} reference files`);
    return;
  }
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${path.relative(REPO, OUT)}: ${entries.length} files${missing.length ? `, ${missing.length} not found (${missing.join(", ")})` : ""}`);
  for (const e of entries) console.log(`  ${e.structureVersion.padEnd(7)} ${String(e.pillarCount).padStart(2)} pillars  ${e.framework.padEnd(14)} ${e.file}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
