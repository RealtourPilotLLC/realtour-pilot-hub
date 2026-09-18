// READ-ONLY PROOF for R05 (Sep 18) — the five hostname decisions that stood
// between the review cuts and a private store, run as the SHIPPED functions
// against the REAL token and the REAL rows, with the code they replaced beside
// them so the difference is visible rather than asserted.
//
// It reads: the production ReviewSubmission rows that carry a blobUrl, and the
// BLOB_READ_WRITE_TOKEN off .env. It writes nothing, anywhere — no database
// write, no blob write, no delete. The only network calls it makes are the two
// at the end, and both are opt-in (--live) and read-only.
//
// Usage, from the repo root:
//   set -a && source .env; set +a
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/_fix/R05/probe-store-decisions.ts [--live]
import { readFileSync } from "node:fs";
import { prisma } from "../../../src/lib/prisma";
import {
  blobFetchDecision,
  ownCutObject,
  blobStoreIdOf,
  blobStoreTokens,
  fetchableCutUrl,
} from "../../../src/lib/reviewCuts";

const LIVE = process.argv.includes("--live");

/** The worktree has no .env of its own; fall back to the checkout's. */
function envVar(name: string): string {
  const fromEnv = (process.env[name] ?? "").trim();
  if (fromEnv) return fromEnv;
  for (const rel of ["../../../.env", "../../../../../.env"]) {
    try {
      const line = readFileSync(new URL(rel, import.meta.url), "utf8")
        .split("\n")
        .find((l) => l.startsWith(`${name}=`));
      if (line) return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
    } catch { /* next candidate */ }
  }
  return "";
}

// ---------------------------------------------------------------------------
// THE CODE THIS REPLACED, copied verbatim off the pre-Sep-18 files so the
// before/after is a measurement and not a memory.
// ---------------------------------------------------------------------------
/** src/app/review/actions.ts finishCutUpload — the upload's own finalize. */
const OLD_FINALIZE = (url: string) => /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//.test(url);
/** src/app/review/actions.ts abandonCutUpload AND removeCut — both delete guards. */
const OLD_DELETE = (url: string) => /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/review-cuts\//.test(url);
/** src/lib/reviewCuts.ts startDropboxCopy / topazJobs — there was no guard at
 *  all: the bare object URL went straight to Dropbox, Topaz and the probes. */
const OLD_HANDOFF = (url: string) => url;

const tick = (b: boolean) => (b ? "yes" : "NO ");
const line = (s: string) => console.log(s);

async function main() {
  const rw = envVar("BLOB_READ_WRITE_TOKEN");
  if (rw) process.env.BLOB_READ_WRITE_TOKEN = rw;
  const tokens = blobStoreTokens();
  line(`token store id : ${blobStoreIdOf(rw) || "(no token found)"}${tokens.length > 1 ? `  (+${tokens.length - 1} legacy)` : ""}`);

  const rows = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null } },
    select: { id: true, blobUrl: true, blobPathname: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  line(`production rows carrying a blobUrl: ${rows.length}\n`);

  // =========================================================================
  line("── 1. TODAY (the public store). Nothing may change.");
  // =========================================================================
  let sameUrl = 0, finalizeOk = 0, deleteOk = 0, fetchNoCred = 0;
  for (const r of rows) {
    const url = r.blobUrl!;
    const f = blobFetchDecision(url);
    const o = ownCutObject(url);
    const handoff = await fetchableCutUrl(r, { purpose: "probe" });
    if (f.ok && f.authorization === null) fetchNoCred++;
    if (o.ok) finalizeOk++;
    if (o.ok && o.token) deleteOk++;
    if (handoff.ok && handoff.url === OLD_HANDOFF(url) && !handoff.signed) sameUrl++;
  }
  line(`   fetch: allowed with NO credential           ${fetchNoCred}/${rows.length}`);
  line(`   finalize: accepted  old ${rows.filter((r) => OLD_FINALIZE(r.blobUrl!)).length}/${rows.length}   new ${finalizeOk}/${rows.length}`);
  line(`   delete:   aimable   old ${rows.filter((r) => OLD_DELETE(r.blobUrl!)).length}/${rows.length}   new ${deleteOk}/${rows.length}`);
  line(`   handoff url byte-for-byte unchanged         ${sameUrl}/${rows.length}  (no signing call made)`);

  // =========================================================================
  line("\n── 2. THE SAME OBJECTS ON A PRIVATE STORE (the store that does not exist");
  line("      yet: each row's own host rewritten `.public.` → `.private.`).");
  // =========================================================================
  const priv = rows.map((r) => ({ ...r, blobUrl: r.blobUrl!.replace(".public.", ".private.") }));
  let pFinalizeOld = 0, pFinalizeNew = 0, pDeleteOld = 0, pDeleteNew = 0, pFetchToken = 0;
  for (const r of priv) {
    if (OLD_FINALIZE(r.blobUrl)) pFinalizeOld++;
    if (OLD_DELETE(r.blobUrl)) pDeleteOld++;
    const f = blobFetchDecision(r.blobUrl);
    const o = ownCutObject(r.blobUrl);
    if (f.ok && f.authorization === `Bearer ${rw}`) pFetchToken++;
    if (o.ok) pFinalizeNew++;
    if (o.ok && o.token === rw) pDeleteNew++;
  }
  line(`   finalize accepts the upload   old ${pFinalizeOld}/${priv.length}   new ${pFinalizeNew}/${priv.length}`);
  line(`   delete can be aimed           old ${pDeleteOld}/${priv.length}   new ${pDeleteNew}/${priv.length}`);
  line(`   our own fetch carries the store token      ${pFetchToken}/${priv.length}`);

  // =========================================================================
  line("\n── 3. THE CUTOVER: one row still in the old store, one already in the new.");
  // =========================================================================
  const OLD_STORE = blobStoreIdOf(rw) || "mphvkcyomow88h9w";
  const NEW_STORE = "newprivatestore99";
  const oldRow = `https://${OLD_STORE}.public.blob.vercel-storage.com/review-cuts/p1/s1/a.mp4`;
  const newRow = `https://${NEW_STORE}.private.blob.vercel-storage.com/review-cuts/p1/s2/b.mp4`;
  const primaryOnly = [`vercel_blob_rw_${NEW_STORE}_secret`];
  const bothTokens = [`vercel_blob_rw_${NEW_STORE}_secret`, rw];
  line(`   with ONLY the new token (the order the old handover gave):`);
  line(`     old-store row readable ${tick(blobFetchDecision(oldRow, primaryOnly).ok)}   deletable ${tick(!!(ownCutObject(oldRow, primaryOnly) as { token?: string }).token)}   <-- its bytes are stranded`);
  line(`     new-store row readable ${tick(blobFetchDecision(newRow, primaryOnly).ok)}   deletable ${tick(!!(ownCutObject(newRow, primaryOnly) as { token?: string }).token)}`);
  line(`   with BOTH tokens (BLOB_READ_WRITE_TOKEN + _LEGACY, the new order):`);
  line(`     old-store row readable ${tick(blobFetchDecision(oldRow, bothTokens).ok)}   deletable ${tick(!!(ownCutObject(oldRow, bothTokens) as { token?: string }).token)}`);
  line(`     new-store row readable ${tick(blobFetchDecision(newRow, bothTokens).ok)}   deletable ${tick(!!(ownCutObject(newRow, bothTokens) as { token?: string }).token)}`);

  // =========================================================================
  line("\n── 4. FIXTURES — does anything leave the building that shouldn't?");
  // =========================================================================
  const fixtures: [string, string][] = [
    ["our store, private, lower-case host", `https://${OLD_STORE}.private.blob.vercel-storage.com/review-cuts/p/s/c.mp4`],
    ["our store, private, UPPER-CASE host", `https://${OLD_STORE.toUpperCase()}.PRIVATE.blob.vercel-storage.com/review-cuts/p/s/c.mp4`],
    ["our store, public", `https://${OLD_STORE}.public.blob.vercel-storage.com/review-cuts/p/s/c.mp4`],
    ["ANOTHER store, private", "https://someoneelse999.private.blob.vercel-storage.com/review-cuts/p/s/c.mp4"],
    ["our store, NOT a review cut", `https://${OLD_STORE}.public.blob.vercel-storage.com/other/thing.mp4`],
    ["look-alike domain", `https://${OLD_STORE}.private.blob.vercel-storage.com.evil.test/review-cuts/p/s/c.mp4`],
    ["not a url", "review-cuts/p/s/c.mp4"],
  ];
  for (const [what, url] of fixtures) {
    const f = blobFetchDecision(url);
    const o = ownCutObject(url);
    const fetchWord = f.ok ? (f.authorization ? "ALLOWED + token" : "ALLOWED, no token") : `REFUSED (${f.reason})`;
    const delWord = o.ok ? (o.token ? "DELETABLE with our token" : "no token configured") : `REFUSED (${o.reason})`;
    line(`   ${what.padEnd(38)} fetch: ${fetchWord.padEnd(20)} delete: ${delWord}`);
  }

  // =========================================================================
  line("\n── 5. THE SIGNED HANDOFF (the part that cannot be proven here).");
  // =========================================================================
  line("   A private object's handoff is issueSignedToken → presignUrl. No private");
  line("   store exists, so on every row above fetchableCutUrl took the public");
  line("   branch and never reached it. What CAN be shown is that the SDK exports");
  line("   both and that the delegation is pathname-scoped:");
  const blob = (await import("@vercel/blob")) as Record<string, unknown>;
  line(`     issueSignedToken exported: ${tick(typeof blob.issueSignedToken === "function")}   presignUrl exported: ${tick(typeof blob.presignUrl === "function")}`);
  if (LIVE && rw && rows[0]) {
    const pathname = rows[0].blobPathname ?? "";
    line(`   --live: asking the control API for a GET delegation on ${pathname.slice(0, 60)}…`);
    try {
      const { issueSignedToken, presignUrl } = await import("@vercel/blob");
      const signed = await issueSignedToken({ token: rw, pathname, operations: ["get"], validUntil: Date.now() + 300_000 });
      line(`     delegation issued, valid until ${new Date(signed.validUntil).toISOString()}`);
      const wrong = await presignUrl(signed, { operation: "get", pathname: "review-cuts/not/this/one.mp4", access: "private" })
        .then(() => "ACCEPTED — the delegation is NOT pathname-scoped")
        .catch((e) => `refused: ${(e as Error).message.slice(0, 80)}`);
      line(`     presigning a DIFFERENT pathname with it → ${wrong}`);
    } catch (e) {
      line(`     control API refused: ${(e as Error).message.slice(0, 160)}`);
      line("     (expected on a public store — this is the unproven half; see the handover.)");
    }
  } else {
    line("   Re-run with --live to ask the control API whether it will issue one at all.");
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
