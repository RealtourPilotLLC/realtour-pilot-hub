// READ-ONLY. Does the store id in BLOB_READ_WRITE_TOKEN match the host of a
// real blobUrl once WHATWG URL has parsed it? (Blocker 1, Sep 17.)
import { readFileSync } from "node:fs";
import { prisma } from "../../../src/lib/prisma";

// tsx does not autoload .env (Prisma self-loads its own URL) and this worktree
// runs without `source .env`, so read the one variable we need straight off disk.
function tokenFromEnvFile(): string {
  try {
    const line = readFileSync(new URL("../../../.env", import.meta.url), "utf8")
      .split("\n")
      .find((l) => l.startsWith("BLOB_READ_WRITE_TOKEN="));
    return line ? line.slice("BLOB_READ_WRITE_TOKEN=".length).trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}

async function main() {
  const rw = process.env.BLOB_READ_WRITE_TOKEN || tokenFromEnvFile();
  const storeId = rw.split("_")[3] ?? "";
  console.log("token store id      :", storeId);
  console.log("lowercased          :", storeId.toLowerCase());
  console.log("differ by case only :", storeId !== storeId.toLowerCase());

  const rows = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null } },
    select: { id: true, blobUrl: true },
  });
  const hostsRaw = new Set<string>();
  const hostsParsed = new Set<string>();
  for (const r of rows) {
    hostsRaw.add(r.blobUrl!.split("/")[2] ?? "?");
    try { hostsParsed.add(new URL(r.blobUrl!).host); } catch { hostsParsed.add("UNPARSEABLE"); }
  }
  console.log("rows with a blobUrl :", rows.length);
  console.log("host, as stored     :", [...hostsRaw].join(", "));
  console.log("host, via new URL() :", [...hostsParsed].join(", "));

  for (const host of hostsParsed) {
    const priv = host.replace(".public.", ".private.");
    console.log(`\nif that object were private, host would be: ${priv}`);
    console.log("  OLD guard (case-sensitive) ->",
      priv !== `${storeId}.private.blob.vercel-storage.com` ? "REFUSED (502)" : "allowed");
    console.log("  NEW guard (case-insensitive) ->",
      priv !== `${storeId.toLowerCase()}.private.blob.vercel-storage.com` ? "REFUSED (502)" : "allowed");
  }
  await prisma.$disconnect();
}
main();
