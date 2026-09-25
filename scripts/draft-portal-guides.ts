// ---------------------------------------------------------------------------
// DRAFT PORTAL GUIDES → one reviewable bundle (CP-13, Sep 24 2026).
//
//   npx tsx scripts/draft-portal-guides.ts            # check + write docs/portal-guides/guides.json
//   npx tsx scripts/draft-portal-guides.ts --check    # check only, write nothing
//   npx tsx scripts/draft-portal-guides.ts --out <file>
//
// FILES ONLY. This script imports nothing from src/ and never constructs a
// database client: the database it would reach from this machine is live
// production, and loading client-facing guides is not a thing to do from a
// script. It reads the drafts in docs/portal-guides/*.md, checks them, and
// writes the exact input the /content/resources authoring page takes — every
// guide `published: false`. Publishing is Jordan's, on that page, where a guide
// with no owner or with placeholder text is refused.
//
// What it checks, because each has bitten a client-facing sentence before:
//   · the four fields the authoring page requires (title, group, body) plus a
//     summary, and a slug that is exactly the one the page will derive from the
//     title — the portal links to guides by that slug (?tab=resources&r=…);
//   · no placeholder words (the same TODO/TBD/lorem ipsum/placeholder test
//     setResourcePublished applies), so a draft cannot be approved half-done;
//   · no em or en dashes: Jordan's rule for anything a client reads.
// The group keys and action keys are checked against the app's own lists by
// the drill (scripts/_drill/cp13-program-messages.ts), which can load them.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..");
const DIR = path.join(REPO, "docs/portal-guides");

export type GuideDraft = {
  file: string;
  slug: string;
  title: string;
  groupKey: string;
  summary: string | null;
  body: string;
  platform: string | null;
  deviceContext: string | null;
  linkedActions: string[];
  sortOrder: number;
  /** Proposed keeper, by first name; resolved to an AppUser when a person loads it. */
  owner: string | null;
  published: false;
};

/** The authoring page's own slug rule (portalResourcesAdmin.slugify). */
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "guide";
const PLACEHOLDER = /\b(TODO|TBD|lorem ipsum|placeholder)\b/i;
const DASH = /[—–]/;

function parse(file: string, text: string): { draft: GuideDraft | null; problems: string[] } {
  const problems: string[] = [];
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { draft: null, problems: [`${file}: no front matter (--- … ---)`] };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const body = m[2].trim();
  const title = meta.title ?? "";
  if (title.length < 3) problems.push(`${file}: a guide needs a title`);
  if (!/^[A-Z_]+$/.test(meta.group ?? "")) problems.push(`${file}: group must be a Resources group key (e.g. YOUR_MONTH)`);
  if (!body) problems.push(`${file}: empty body`);
  if (!meta.summary) problems.push(`${file}: a summary is missing`);
  if (meta.slug !== slugify(title)) problems.push(`${file}: slug "${meta.slug}" is not the one the page derives from the title ("${slugify(title)}")`);
  const actions = (meta.actions ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  for (const a of actions) if (!/^[a-z_]+$/.test(a)) problems.push(`${file}: "${a}" is not an action key`);
  for (const [where, s] of [["title", title], ["summary", meta.summary ?? ""], ["body", body]] as const) {
    if (PLACEHOLDER.test(s)) problems.push(`${file}: placeholder text in the ${where}`);
    if (DASH.test(s)) problems.push(`${file}: an em or en dash in the ${where} (client copy uses none)`);
  }
  return {
    problems,
    draft: {
      file, slug: meta.slug ?? slugify(title), title, groupKey: meta.group ?? "", summary: meta.summary || null, body,
      platform: meta.platform || null, deviceContext: meta.device || null, linkedActions: actions,
      sortOrder: Number.isFinite(Number(meta.order)) ? Number(meta.order) : 0, owner: meta.owner || null, published: false,
    },
  };
}

export function loadGuideDrafts(dir = DIR): { drafts: GuideDraft[]; problems: string[] } {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md").sort();
  const drafts: GuideDraft[] = [];
  const problems: string[] = [];
  for (const f of files) {
    const r = parse(f, fs.readFileSync(path.join(dir, f), "utf8"));
    problems.push(...r.problems);
    if (r.draft) drafts.push(r.draft);
  }
  const seen = new Set<string>();
  for (const d of drafts) {
    if (seen.has(d.slug)) problems.push(`${d.file}: slug "${d.slug}" is used twice`);
    seen.add(d.slug);
  }
  return { drafts, problems };
}

function main() {
  const check = process.argv.includes("--check");
  const outArg = process.argv.indexOf("--out");
  const out = outArg > 0 ? path.resolve(process.argv[outArg + 1] ?? "") : path.join(DIR, "guides.json");
  const { drafts, problems } = loadGuideDrafts();
  for (const d of drafts) console.log(`  ${d.groupKey.padEnd(18)} ${String(d.sortOrder).padStart(2)}  ${d.title}${d.linkedActions.length ? `  [${d.linkedActions.join(", ")}]` : ""}`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`\n${drafts.length} drafts, all unpublished, all clean.`);
  if (check) return;
  fs.writeFileSync(out, `${JSON.stringify({ note: "Drafts for /content/resources. Unpublished; publishing is Jordan's.", guides: drafts }, null, 2)}\n`);
  console.log(`wrote ${path.relative(REPO, out)}`);
}

if (require.main === module) main();
