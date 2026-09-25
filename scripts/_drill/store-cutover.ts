// ---------------------------------------------------------------------------
// STORE CUTOVER — which store an upload lands in, decided by ONE connection
// (Sep 25 2026). No database, no network: the functions are pure over env.
//
//   NODE_OPTIONS=--conditions=react-server npx tsx \
//     --require ./scripts/_drill/_drill-preload.cjs scripts/_drill/store-cutover.ts
//
// The rule under test (src/lib/reviewCuts.ts, cutUploadToken/cutStoreAccess):
// while REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN is absent, nothing changes; once
// it is present, new uploads are signed for the PRIVATE store and the browser
// is told "private" — both from the same variable, so they cannot disagree —
// and the public store's token stays in the list, so its not-yet-moved objects
// remain readable and deletable.
// ---------------------------------------------------------------------------
import { makeChecker } from "./_harness";

const PUB = "vercel_blob_rw_mphvkCyOMoW88h9w_publicsecretpublicsecret";
const PRIV = "vercel_blob_rw_Ivpn6ZpIy2r0feKR_privatesecretprivatesecret";
const pubUrl = "https://mphvkcyomow88h9w.public.blob.vercel-storage.com/review-cuts/p1/s1/cut-abc.mp4";
const privUrl = "https://ivpn6zpiy2r0fekr.private.blob.vercel-storage.com/review-cuts/p1/s2/cut-def.mp4";

async function main() {
  const c = makeChecker();
  process.env.DATABASE_URL = "postgresql://nobody@127.0.0.1:1/none";
  const rc = await import("../../src/lib/reviewCuts");
  const set = (env: Record<string, string | undefined>) => {
    for (const k of ["REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN", "BLOB_READ_WRITE_TOKEN_LEGACY", "NEXT_PUBLIC_REVIEW_CUT_ACCESS"]) delete process.env[k];
    Object.assign(process.env, env);
  };

  c.head("1 · TODAY — only the public store is connected: nothing changes");
  set({ BLOB_READ_WRITE_TOKEN: PUB });
  c.ok("the upload token is the public store's", rc.cutUploadToken() === PUB);
  c.ok("the browser is told public", rc.cutStoreAccess() === "public");
  c.ok("a public cut is fetched with no credential (as before)", (() => { const d = rc.blobFetchDecision(pubUrl); return d.ok && d.authorization === null; })());
  c.ok("a public cut is still deletable with its token", (() => { const o = rc.ownCutObject(pubUrl); return o.ok && o.token === PUB; })());
  c.ok("the old flag alone still means private (unchanged fallback)", (() => { set({ BLOB_READ_WRITE_TOKEN: PUB, NEXT_PUBLIC_REVIEW_CUT_ACCESS: "private" }); return rc.cutStoreAccess() === "private"; })());

  c.head("2 · CONNECTED — the private store's token is present");
  set({ BLOB_READ_WRITE_TOKEN: PUB, REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN: PRIV });
  c.ok("new uploads are signed for the PRIVATE store", rc.cutUploadToken() === PRIV);
  c.ok("…and the browser is told private — from the same variable", rc.cutStoreAccess() === "private");
  c.ok("both tokens are held, private first", JSON.stringify(rc.blobStoreTokens()) === JSON.stringify([PRIV, PUB]));
  c.ok("a private cut is fetched WITH the private token", (() => { const d = rc.blobFetchDecision(privUrl); return d.ok && d.token === PRIV; })());
  c.ok("a private cut is deletable with the private token", (() => { const o = rc.ownCutObject(privUrl); return o.ok && o.token === PRIV; })());
  c.ok("a not-yet-moved PUBLIC cut still plays (no credential needed)", (() => { const d = rc.blobFetchDecision(pubUrl); return d.ok && d.authorization === null; })());
  c.ok("a private cut is sent WITH the bearer header", (() => { const d = rc.blobFetchDecision(privUrl); return d.ok && d.authorization === `Bearer ${PRIV}`; })());
  c.ok("…and can still be pruned, with the PUBLIC token (the 08:40 window stays shut)", (() => { const o = rc.ownCutObject(pubUrl); return o.ok && o.token === PUB; })());
  c.ok("the same token twice is listed once", (() => { set({ BLOB_READ_WRITE_TOKEN: PRIV, REVIEW_CUTS_PRIVATE_READ_WRITE_TOKEN: PRIV }); return rc.blobStoreTokens().length === 1; })());

  c.head("3 · the upload route and the reservation carry the decision");
  const fs = await import("node:fs");
  const route = fs.readFileSync("src/app/api/review/upload/route.ts", "utf8");
  c.ok("handleUpload is given the token explicitly (not the env default)", /handleUpload\(\{[\s\S]{0,400}token: cutUploadToken\(\)/.test(route));
  const actions = fs.readFileSync("src/app/review/actions.ts", "utf8");
  c.ok("startCutUpload returns access from cutStoreAccess()", /access: cutStoreAccess\(\)/.test(actions));
  const uploader = fs.readFileSync("src/components/editing/CutUploader.tsx", "utf8");
  c.ok("the browser uses the server's word", /access: started\.access \?\? CUT_STORE_ACCESS/.test(uploader));
  c.summary();
}
main().catch((e) => { console.error(e); process.exit(1); });
