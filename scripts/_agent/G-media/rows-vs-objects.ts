// READ-ONLY. How many ReviewSubmission rows point at the public cut store, and
// do the rows and the objects agree? The migration plan depends on the answer:
// a row whose object is already gone needs nothing moved, and an object no row
// claims is an orphan that can simply be deleted.
import { prisma } from "../../../src/lib/prisma";

async function main() {
  const rows = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null } },
    select: { id: true, projectId: true, status: true, blobUrl: true, blobPathname: true, fileName: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log("ReviewSubmission rows with a blobUrl:", rows.length);
  const hosts = new Map<string, number>();
  for (const r of rows) {
    let h = "(unparseable)";
    try { h = new URL(r.blobUrl!).host; } catch { /* keep */ }
    hosts.set(h, (hosts.get(h) ?? 0) + 1);
  }
  console.log("hosts:", [...hosts.entries()]);
  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
  console.log("by status:", [...byStatus.entries()]);

  const line = (await import("node:fs")).readFileSync(new URL("../../../.env", import.meta.url), "utf8")
    .split("\n").find((l) => l.startsWith("BLOB_READ_WRITE_TOKEN="));
  const token = (line ?? "").slice("BLOB_READ_WRITE_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
  const data = (await (await fetch("https://vercel.com/api/blob/?limit=1000", {
    headers: { authorization: `Bearer ${token}` },
  })).json()) as { blobs: { url: string; pathname: string }[] };

  const rowUrls = new Set(rows.map((r) => r.blobUrl!));
  const objUrls = new Set(data.blobs.map((b) => b.url));
  console.log("objects in store:", objUrls.size);
  console.log("rows whose object is GONE (nothing to move):", [...rowUrls].filter((u) => !objUrls.has(u)).length);
  const orphans = [...objUrls].filter((u) => !rowUrls.has(u));
  console.log("objects NO row claims (orphans):", orphans.length);
  for (const o of orphans) console.log("   orphan:", decodeURIComponent(new URL(o).pathname));
}

main().finally(() => prisma.$disconnect());
