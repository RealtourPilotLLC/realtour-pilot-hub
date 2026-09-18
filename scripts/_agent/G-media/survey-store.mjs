// READ-ONLY. Lists the review-cuts blob store and, for every object, asks the
// public CDN for it with NO credentials at all. Prints the exposure count.
// Run: node scripts/_agent/G-media/survey-store.mjs   (reads .env itself)
import { readFileSync } from "node:fs";
function fromEnvFile(key) {
  try {
    const line = readFileSync(new URL("../../../.env", import.meta.url), "utf8")
      .split("\n").find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "") : "";
  } catch { return ""; }
}
const token = process.env.BLOB_READ_WRITE_TOKEN || fromEnvFile("BLOB_READ_WRITE_TOKEN");
if (!token) { console.error("no BLOB_READ_WRITE_TOKEN"); process.exit(1); }
const res = await fetch("https://vercel.com/api/blob/?limit=1000", {
  headers: { authorization: `Bearer ${token}` },
});
if (!res.ok) { console.error("list failed", res.status, await res.text()); process.exit(1); }
const data = await res.json();
console.log("objects:", data.blobs.length, "hasMore:", data.hasMore);
let open = 0, longCache = 0, bytes = 0;
for (const b of data.blobs) {
  bytes += b.size ?? 0;
  const r = await fetch(b.url, { method: "GET", headers: { Range: "bytes=0-0" }, cache: "no-store" })
    .catch(() => ({ status: 0, headers: new Headers() }));
  const cc = r.headers?.get?.("cache-control") ?? "";
  const anon = r.status === 200 || r.status === 206;
  if (anon) open++;
  const m = /max-age=(\d+)/.exec(cc);
  if (m && Number(m[1]) > 3600) longCache++;
  await r.body?.cancel?.().catch(() => {});
  console.log([
    String(r.status).padStart(3),
    anon ? "OPEN " : "shut ",
    String(b.size ?? 0).padStart(10),
    cc.padEnd(34),
    new URL(b.url).host,
    b.pathname,
  ].join("  "));
}
console.log(`\nTOTAL ${data.blobs.length} objects, ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`world-readable with no session: ${open}`);
console.log(`still advertising cache-control max-age > 1h: ${longCache}`);
