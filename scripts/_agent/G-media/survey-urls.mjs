// READ-ONLY. Prints each object's real URL so the path-guessability question
// can be answered from evidence rather than from what the token asked for
// (addRandomSuffix is a REQUEST; the store decides).
import { readFileSync } from "node:fs";
const line = readFileSync(new URL("../../../.env", import.meta.url), "utf8")
  .split("\n").find((l) => l.startsWith("BLOB_READ_WRITE_TOKEN="));
const token = (line ?? "").slice("BLOB_READ_WRITE_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
const data = await (await fetch("https://vercel.com/api/blob/?limit=1000", {
  headers: { authorization: `Bearer ${token}` },
})).json();
for (const b of data.blobs) {
  const last = new URL(b.url).pathname.split("/").pop();
  const suffixed = /-[A-Za-z0-9]{8,}\.[a-z0-9]+$/.test(decodeURIComponent(last));
  console.log(suffixed ? "suffixed " : "GUESSABLE", decodeURIComponent(last));
}
console.log("\nuploadedAt range:", data.blobs.map((b) => b.uploadedAt).sort()[0], "→",
  data.blobs.map((b) => b.uploadedAt).sort().pop());
