// READ-ONLY PROOF for BLOCKER 1 (Sep 17). Runs the SHIPPED guard —
// blobFetchDecision, imported from the stream route itself — against the real
// BLOB_READ_WRITE_TOKEN and the real blobUrl of every ReviewSubmission that has
// one, with the host rewritten to `.private.` to stand in for the store that
// does not exist yet. Also runs the OLD, case-sensitive comparison beside it so
// the difference is visible rather than asserted.
import { readFileSync } from "node:fs";
import { prisma } from "../../../src/lib/prisma";
import { blobFetchDecision } from "../../../src/app/api/review/cut/[id]/stream/route";

// tsx does not autoload .env (Prisma self-loads its own URL), and this worktree
// runs without `source .env`, so read the one variable we need off disk.
function tokenFromEnvFile(): string {
  try {
    const line = readFileSync(new URL("../../../.env", import.meta.url), "utf8")
      .split("\n")
      .find((l) => l.startsWith("BLOB_READ_WRITE_TOKEN="));
    return line ? line.slice("BLOB_READ_WRITE_TOKEN=".length).trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}

/** The comparison exactly as it shipped in f3d70a3, for the before/after. */
function oldGuardAllows(blobUrl: string, rw: string | undefined): boolean {
  let host = "";
  try { host = new URL(blobUrl).host; } catch { return false; }
  if (!host.endsWith(".blob.vercel-storage.com")) return false;
  if (!host.includes(".private.")) return true;
  const storeId = rw ? rw.split("_")[3] ?? "" : "";
  return !(!storeId || host !== `${storeId}.private.blob.vercel-storage.com`);
}

async function main() {
  const rw = process.env.BLOB_READ_WRITE_TOKEN || tokenFromEnvFile();
  const storeId = rw.split("_")[3] ?? "";
  console.log(`token store id: ${storeId}  (lower-cased: ${storeId.toLowerCase()})\n`);

  const rows = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null } },
    select: { id: true, blobUrl: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`production rows carrying a blobUrl: ${rows.length}`);

  let oldPrivateOk = 0, newPrivateOk = 0, publicOk = 0;
  for (const r of rows) {
    const asPrivate = r.blobUrl!.replace(".public.blob.", ".private.blob.");
    const now = blobFetchDecision(r.blobUrl!, rw);
    const priv = blobFetchDecision(asPrivate, rw);
    if (now.ok) publicOk++;
    if (priv.ok) newPrivateOk++;
    if (oldGuardAllows(asPrivate, rw)) oldPrivateOk++;
  }
  console.log(`  today (public URLs), new guard allows : ${publicOk}/${rows.length}  (no authorization header sent)`);
  console.log(`  same objects as .private., OLD guard  : ${oldPrivateOk}/${rows.length} allowed  <-- the blocker`);
  console.log(`  same objects as .private., NEW guard  : ${newPrivateOk}/${rows.length} allowed, with Bearer <our token>`);

  // Fixtures: the credential must still be refused to anything that is not our
  // own store's private host.
  const sample = rows[0]?.blobUrl ?? `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com/review-cuts/x.mov`;
  const cases: Array<[string, string]> = [
    ["our store, private, lower-case host", sample.replace(".public.blob.", ".private.blob.")],
    ["our store, private, UPPER-CASE host", sample.replace(".public.blob.", ".private.blob.").replace(storeId.toLowerCase(), storeId.toUpperCase())],
    ["our store, public", sample],
    ["ANOTHER store, private", `https://someoneelse99.private.blob.vercel-storage.com/review-cuts/x.mov`],
    ["look-alike domain", `https://${storeId.toLowerCase()}.private.blob.vercel-storage.com.evil.test/x.mov`],
    ["not a url", "not-a-url"],
  ];
  console.log("\nfixtures (does the token leave the building?)");
  for (const [label, url] of cases) {
    const d = blobFetchDecision(url, rw);
    const verdict = d.ok ? (d.authorization ? "ALLOWED + token" : "ALLOWED, no token") : `REFUSED (${d.reason})`;
    console.log(`  ${label.padEnd(38)} ${verdict}`);
  }
  await prisma.$disconnect();
}
main();
