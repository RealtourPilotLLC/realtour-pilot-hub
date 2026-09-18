// MOVE THE REVIEW CUTS INTO THE PRIVATE STORE — one row at a time, copy and
// verify before anything live changes, never delete the original.
//
// R05 / RTP-01, Sep 18. This replaces the migration step the old handover
// described, which could not have worked:
//
//   putFromUrl(pathname, oldUrl, { access: "private", token: NEW_TOKEN, … })
//
// In @vercel/blob 2.8.0 `putFromUrl` is the DEPRECATED image pipeline — its
// options type requires `optimizeImage`, its doc comment reads "Fetches an
// image from a public URL, optimizes it through Vercel Image Optimization, and
// stores the optimized output", and it needs OIDC auth. Pointed at a 368 MB
// .mov it does not copy a video; `copy()` is no use either, because it copies
// WITHIN one store. A cross-store move has to stream: read the object out of
// the old store, `put` it into the new one.
//
// THE ORDER, and why it cannot strand a row:
//   · the deployment already holds BOTH tokens before this runs
//     (BLOB_READ_WRITE_TOKEN = new, BLOB_READ_WRITE_TOKEN_LEGACY = old), so a
//     row may name either store at any instant and every read, probe and
//     delete still resolves (src/lib/reviewCuts.ts, THE CUT STORE);
//   · per row: copy → HEAD the copy and compare its size to the source →
//     write the ledger line → only then update the row. A crash anywhere
//     leaves the row pointing at an object that still exists;
//   · the old object is NEVER deleted here. It is the only copy of anything
//     this got wrong, and the house rule is retire, don't delete;
//   · --rollback puts every ledger line's row back where it was.
//
// WHAT THIS DOES NOT SOLVE: the old public URLs stay readable by anyone holding
// one until the old objects are deleted, which is a separate, later, deliberate
// step. Copying does not revoke anything.
//
// Usage, from the repo root:
//   npx tsx scripts/_fix/R05/migrate-cut-store.ts --new-token <rw-token-of-the-private-store>
//   …then add --apply to actually move them.
//   npx tsx scripts/_fix/R05/migrate-cut-store.ts --rollback --ledger <file>
//
// NOTHING HERE HAS EVER BEEN RUN. No private store exists to run it against.
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { cutIdentityHash } from "@/lib/cutTranscripts";
import { Readable } from "node:stream";
import { prisma } from "../../../src/lib/prisma";
import { blobFetchDecision, blobStoreIdOf, blobStoreTokens } from "../../../src/lib/reviewCuts";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
};

const APPLY = flag("apply");
const ROLLBACK = flag("rollback");
const LEDGER = value("ledger") ?? `cut-store-migration-${new Date().toISOString().slice(0, 10)}.jsonl`;
const NEW_TOKEN = value("new-token") ?? process.env.BLOB_READ_WRITE_TOKEN_NEW ?? "";

type LedgerLine = {
  at: string;
  submissionId: string;
  oldUrl: string;
  oldPathname: string | null;
  newUrl: string;
  newPathname: string;
  bytes: number;
};

async function rollback() {
  if (!existsSync(LEDGER)) throw new Error(`no ledger at ${LEDGER} — nothing to roll back`);
  const lines = readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerLine);
  console.log(`ledger ${LEDGER}: ${lines.length} moved rows`);
  for (const l of lines.reverse()) {
    const row = await prisma.reviewSubmission.findUnique({ where: { id: l.submissionId }, select: { blobUrl: true } });
    if (!row) { console.log(`   ${l.submissionId}  row is gone — nothing to restore`); continue; }
    if (row.blobUrl !== l.newUrl) { console.log(`   ${l.submissionId}  points somewhere else now (${row.blobUrl ?? "null"}) — left alone`); continue; }
    if (!APPLY) { console.log(`   ${l.submissionId}  would restore → ${l.oldUrl}`); continue; }
    // contentHash is deliberately NOT unwound: it was pinned to the value the
    // row already had, the bytes never moved, and un-pinning it would put the
    // URL back into the identity and break the same approvals on the way back.
    await prisma.reviewSubmission.update({ where: { id: l.submissionId }, data: { blobUrl: l.oldUrl, blobPathname: l.oldPathname } });
    console.log(`   ${l.submissionId}  restored → ${l.oldUrl}`);
  }
  console.log(APPLY ? "\nrolled back. The copies in the new store were NOT deleted." : "\nDRY RUN — add --apply.");
}

async function main() {
  if (ROLLBACK) return rollback();
  if (!NEW_TOKEN) throw new Error("--new-token <the private store's read-write token> is required");
  const newStore = blobStoreIdOf(NEW_TOKEN);
  if (!newStore) throw new Error("that does not look like a blob read-write token");
  const held = blobStoreTokens();
  if (held.length === 0) throw new Error("this process holds no BLOB_READ_WRITE_TOKEN — source .env first");
  if (held.some((t) => blobStoreIdOf(t) === newStore)) {
    console.log(`note: this process already holds a token for ${newStore}`);
  }

  const rows = await prisma.reviewSubmission.findMany({
    where: { blobUrl: { not: null } },
    select: { id: true, blobUrl: true, blobPathname: true, status: true, fileName: true, sizeBytes: true, contentHash: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`rows carrying a blobUrl: ${rows.length}   target store: ${newStore}   ledger: ${LEDGER}`);
  console.log(APPLY ? "APPLY — objects will be copied and rows updated.\n" : "DRY RUN — nothing will be copied or written. Add --apply.\n");

  const ledger = APPLY ? createWriteStream(LEDGER, { flags: "a" }) : null;
  let moved = 0, skipped = 0, failed = 0;

  for (const r of rows) {
    const oldUrl = r.blobUrl!;
    const host = new URL(oldUrl).host.toLowerCase();
    const pathname = r.blobPathname ?? decodeURIComponent(new URL(oldUrl).pathname.replace(/^\//, ""));
    const tag = `${r.id}  ${pathname.slice(0, 70)}`;

    if (host.startsWith(`${newStore}.`)) { console.log(`   SKIP  ${tag}  already in the new store`); skipped++; continue; }
    // AN UPLOAD IN FLIGHT IS NOT OURS TO MOVE. The editor's browser is still
    // PUTting parts at the store its token named; copying it now copies a
    // half-file, and the row is about to be rewritten by finalizeCutUpload
    // anyway. Once the deployment has flipped, the next upload lands in the new
    // store on its own; this one finishes where it started and is picked up by
    // a later pass of this script.
    if (r.status === "UPLOADING") { console.log(`   SKIP  ${tag}  upload still in flight`); skipped++; continue; }

    if (!APPLY) { console.log(`   PLAN  ${tag}  ${(r.sizeBytes ?? 0) / 1e6 | 0} MB`); continue; }

    try {
      // Read the source with whatever token owns ITS store (public today, so
      // no header at all; a private legacy store would get its Bearer).
      const decision = blobFetchDecision(oldUrl);
      if (!decision.ok) throw new Error(`cannot read the source (${decision.reason})`);
      const src = await fetch(oldUrl, {
        cache: "no-store",
        headers: decision.authorization ? { authorization: decision.authorization } : {},
      });
      if (!src.ok || !src.body) throw new Error(`source answered ${src.status}`);
      const srcBytes = Number(src.headers.get("content-length") ?? 0) || r.sizeBytes || 0;
      const contentType = src.headers.get("content-type") ?? "video/mp4";

      const { put, head } = await import("@vercel/blob");
      const copied = await put(pathname, Readable.fromWeb(src.body as Parameters<typeof Readable.fromWeb>[0]), {
        access: "private",
        token: NEW_TOKEN,
        // The pathname is the identity every row and every note key already
        // uses — a random suffix here would invent a second one.
        addRandomSuffix: false,
        allowOverwrite: true,
        multipart: true,
        contentType,
        // The same 60s the upload route asks for: a re-homed object must stop
        // being answered from CDN cache within a minute, not a month.
        cacheControlMaxAge: 60,
      });

      // VERIFY BEFORE ANYTHING LIVE CHANGES. A copy nobody measured is a copy
      // nobody can vouch for, and the row is about to stop naming the original.
      const there = await head(copied.url, { token: NEW_TOKEN });
      if (srcBytes && there.size !== srcBytes) throw new Error(`copy is ${there.size} bytes, source was ${srcBytes}`);
      if (there.pathname !== pathname) throw new Error(`copy landed at ${there.pathname}, expected ${pathname}`);

      // The ledger line goes down BEFORE the row moves: it is the only record
      // of where this cut used to live, and --rollback reads it.
      const line: LedgerLine = { at: new Date().toISOString(), submissionId: r.id, oldUrl, oldPathname: r.blobPathname, newUrl: copied.url, newPathname: there.pathname, bytes: there.size };
      await new Promise<void>((res, rej) => ledger!.write(`${JSON.stringify(line)}\n`, (e) => (e ? rej(e) : res())));

      // PIN THE IDENTITY BEFORE THE URL MOVES (check, Sep 18).
      //
      // cutIdentityHash falls back to hashing blobPathname + blobUrl + size +
      // name whenever contentHash is null — and it is null on all 14 rows. So
      // rewriting blobUrl silently changes the identity of the cut, and every
      // gate that compares it stops matching: a client's approval
      // (ClientDecision.contentHash) would no longer name the video they
      // approved, and the posting kit would call an unchanged file stale. The
      // bytes are identical — only the address moved — so the identity must not.
      //
      // contentHash exists for exactly this. Filling it with the CURRENT value
      // freezes the answer, and the fallback never runs again for this row.
      const pinned = r.contentHash ?? cutIdentityHash(r);
      await prisma.reviewSubmission.update({
        where: { id: r.id },
        data: { blobUrl: copied.url, blobPathname: there.pathname, contentHash: pinned },
      });
      console.log(`   MOVED ${tag}  ${there.size} bytes verified`);
      moved++;
    } catch (e) {
      console.error(`   FAIL  ${tag}  ${(e as Error).message}`);
      console.error("         the row was NOT changed and the original was NOT deleted.");
      failed++;
    }
  }

  ledger?.end();
  console.log(`\nmoved ${moved} · skipped ${skipped} · failed ${failed}`);
  if (APPLY) {
    console.log("The old objects are all still there. Delete them only once the new store has");
    console.log("been serving for a while — they are the only copy of anything this got wrong.");
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
