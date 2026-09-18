# Handover — replacing the review-cut store with a private one (RTP-01)

**Status: the CODE is ready. The ACCOUNT STEP has never been performed, and
nothing below step 3 has ever been run by anybody.**

The private store does not exist, so **no code path in this repo has ever read a
private blob, minted a presigned URL for one, or copied an object between
stores.** Everything here about how a private read behaves is read off the
installed SDK (`@vercel/blob` 2.8.0) and off one live, read-only call to Vercel's
control API (§5). It is a plan with a proven mechanism, not a result. **The first
private upload is the first test.** Do it on a day someone is watching.

Last measured 2026-09-18. Probes, all read-only:
`scripts/_fix/R05/probe-store-decisions.ts`, `scripts/_drill/cut-store-prune.ts`
(runs against a throwaway PostgreSQL, never production), `scripts/_fix/G/`,
`scripts/_agent/G-media/`.

---

## 1. Why this exists

The hub's review cuts — unreleased client videos — live in a Vercel Blob store
that was created **public**. A public blob's URL is a permanent, credential-free
link to the file: no session, no expiry, no revocation. Measured, not inferred:
**14 objects, 3.48 GB, all 14 answering an anonymous ranged GET with a 206**, 10
of them still advertising `cache-control: public, max-age=2592000` (30 days).

All 14 paths carry a random suffix, so nobody is guessing them. That is not a
defence — an unguessable URL is still a bearer token that never expires, gets
pasted into Slack, and travels in referrer headers.

**What cannot be done in code: `access` is the browser's word.** The SDK writes
it as the `x-vercel-blob-access` header on the browser's own PUT
(`createPutHeaders`), and `onBeforeGenerateToken` returns a `Pick<>` of seven
keys with no `access` in it. The store has to be **replaced** with one created
private — an account action, in the Vercel dashboard, by a human. That is the
whole of the external dependency.

---

## 2. What the code now does — and what the 2026-09-17 version of this document
got wrong

The previous version of this file said "what has already been done in code"
and listed three things. A verification pass on 2026-09-18 found the claim was
wrong: **six paths still handed a bare public URL to somebody**, and the
document itself scheduled the repairs to four of them *after* the switch, which
would have exposed the live team to known failures.

All six now go through **one place — `src/lib/reviewCuts.ts`, the section headed
THE CUT STORE.** Three rules:

1. **Our own fetches carry the store's read token** (`blobFetchDecision`). The
   stream route's proxy, the Topaz part upload.
2. **Somebody else's fetch gets a short-lived presigned GET** scoped to that one
   pathname (`fetchableCutUrl` → `issueSignedToken` + `presignUrl`). Dropbox's
   `files/save_url`, Meta's `video_url`, a transcription provider, and our own
   header probes — which take a bare URL and send no headers, so they need a URL
   that carries its own permission too. **The read-write token never leaves the
   building.**
3. **No hard-coded hostname decides anything.** The store we own is whatever the
   TOKEN says, and during the cutover we hold two.

| Path | Before 2026-09-18 | Now |
|---|---|---|
| `review/actions.ts` `finishCutUpload` | required `.public.` in the host — refused every private upload | `ownCutObject`: any store we hold a token for, under `review-cuts/` |
| `reviewCuts.ts` `startDropboxCopy` | `files/save_url` with the raw `blobUrl` | presigned GET, 6 h; a failure writes the same Activity line the retry loop already reads |
| `topazJobs.ts` `stepUploading` | bare `fetch(sub.blobUrl)` | same fetch, with the store's `authorization` header |
| `topazJobs.ts` probes ×3, `reviewCuts.recordArrivedDimensions` | `probeVideoMetadata(blobUrl)` | `probeableUrl()` first; an unreadable file skips the render instead of misreporting its audio |
| `publishing.ts` (Instagram) | `videoUrl: cut.blobUrl` to Meta's fetchers | presigned GET, 6 h; an unmintable link FAILS the job with that sentence |
| `cutTranscripts.ts` | `transcribe({ url: cut.blobUrl })` | presigned GET, 2 h; unmintable → `NEEDS_REVIEW` with the reason |
| `abandonCutUpload`, `removeCut`, `pruneReviewUploads` | hard-coded `.public.`; `del()` with whatever token was primary | `deleteCutObject`: aimed at the token that owns THAT object's store |

**Proof, `scripts/_fix/R05/probe-store-decisions.ts`** (read-only; it imports the
shipped functions and runs them against the real token and the real 14 rows,
with the host rewritten to `.private.` to stand in for the store that does not
exist yet):

```
token store id : mphvkcyomow88h9w          production rows carrying a blobUrl: 14

1. TODAY (the public store). Nothing may change.
   fetch: allowed with NO credential           14/14
   finalize: accepted  old 14/14   new 14/14
   delete:   aimable   old 14/14   new 14/14
   handoff url byte-for-byte unchanged         14/14  (no signing call made)

2. THE SAME OBJECTS ON A PRIVATE STORE
   finalize accepts the upload   old 0/14   new 14/14
   delete can be aimed           old 0/14   new 14/14
   our own fetch carries the store token      14/14

4. FIXTURES
   our store, private, lower-case host    fetch: ALLOWED + token      delete: DELETABLE with our token
   our store, private, UPPER-CASE host    fetch: ALLOWED + token      delete: DELETABLE with our token
   our store, public                      fetch: ALLOWED, no token    delete: DELETABLE with our token
   ANOTHER store, private                 fetch: REFUSED (foreign-store) delete: REFUSED (foreign-store)
   our store, NOT a review cut            fetch: ALLOWED, no token    delete: REFUSED (not-a-cut-path)
   look-alike domain                      fetch: REFUSED (unreadable) delete: REFUSED (unreadable)
   not a url                              fetch: REFUSED (unreadable) delete: REFUSED (unreadable)
```

Read the first block carefully: **on today's store every one of these functions
returns exactly what the code it replaced returned.** The public branch of
`fetchableCutUrl` makes no network call and hands back the same URL. This shipped
dormant on purpose — it changes nothing until the store is replaced.

### Still outside this repair, and outside the files it was allowed to touch

- **`src/lib/aryeoDelivery.ts:974`** measures a cut's duration with
  `videoLength(c.blobUrl, …)`, which is `probeVideoMetadata` on a bare URL. On a
  private store it returns `null`, and the rule immediately below it is "NO
  MEASUREMENT, NO STAMP" — so deliveries stop being confirmable rather than
  being confirmed wrongly. The one-line fix is the same `probeableUrl()` the
  Topaz probes now use. **Do this before step 4.**
- **`src/components/editing/CutUploader.tsx`** still says in a comment that
  "§4.1 of that note is the finalize call that refuses a private upload". That
  is no longer true — the finalize accepts either store — and the section
  numbers here have changed. The sentence is stale, not dangerous; correct it
  next time that file is open.
- **`ProgramPublishingJob.mediaValidationJson`** stores the cut's `blobUrl` in
  the approval snapshot. That is a record of what was approved against and is
  kept (retire, don't delete) — but it means old public URLs also sit in that
  column, and re-homing the objects does not rewrite them. It is read for the
  hash comparison, never fetched.

---

## 3. The order to do it in

> **Two orders have been circulated and both were wrong.** "Swap the token, then
> stop while the rest lands" destroys rows (§4). "Move the rows, THEN swap the
> token" — the 2026-09-17 order — leaves a window running the other way: between
> the first moved row and the redeploy, every moved row names a store the
> deployment holds no token for, so its cut will not play, will not copy to
> Dropbox and cannot be pruned. It also scheduled §2's repairs for *after* the
> switch.

The rule that makes an order safe: **at every instant, every row's `blobUrl`
must name a store the deployment holds a token for.** The way to get that is not
to sequence the two carefully — it is to hold **both tokens at once**, so the
question cannot be asked at a bad moment.

1. **Fix `aryeoDelivery.ts` (§2, last block) and deploy it.** It is one line and
   it is the only known consumer still on a bare URL.
2. **Create the new store, private, in the Vercel dashboard.** Copy its
   read-write token. Change nothing else yet. *(Account action — never done.)*
3. **ONE redeploy that sets all three variables together:**
   - `BLOB_READ_WRITE_TOKEN` = the **new** (private) store's token
   - `BLOB_READ_WRITE_TOKEN_LEGACY` = the **old** (public) store's token
   - `NEXT_PUBLIC_REVIEW_CUT_ACCESS` = `private`

   The first two must arrive together because the deployment has to be able to
   read and delete objects in **both** stores from this moment on. The third has
   to arrive in the *same* deploy as the first: the client token is minted from
   `BLOB_READ_WRITE_TOKEN` server-side while the browser sends the `access`
   header itself, so a private store with the flag still `public` — or a public
   store with the flag already `private` — is an upload the control plane
   refuses. *(Unverified: no private store has ever been uploaded to. The public
   half of that refusal is documented — "Cannot use private access on a public
   store".)*

   After this redeploy: **existing rows still name the old store and still work**
   (public objects, read with no credential, deletable with the legacy token).
   **New uploads land in the new store, private.** Nothing is stranded, because
   nothing has moved.

   *Uploads in flight across the redeploy:* an editor whose browser holds the
   previous bundle sends `access: public` against the new private store and the
   PUT is refused — they see an upload error and retry on a reload. An editor
   who already has a signed token for the OLD store finishes into the old store;
   the finalize accepts it (it asks the token, not the hostname) and the row is
   picked up by step 4 like any other. `onUploadCompleted` logs both
   half-flipped states by name.

4. **Move the objects, one row at a time:**
   `npx tsx scripts/_fix/R05/migrate-cut-store.ts --new-token <new> --apply`.
   Per row it copies, HEADs the copy and compares its size to the source, writes
   a ledger line, and only then updates the row — so a crash anywhere leaves the
   row pointing at an object that exists. It skips rows already in the new store
   and rows still `UPLOADING`. **It never deletes the original.** Run it as often
   as you like; it is idempotent.

   *The old handover's step 2 could not have worked.* It called
   `putFromUrl(pathname, oldUrl, { access: "private", token: NEW_TOKEN })`. In
   2.8.0 `putFromUrl` is the deprecated **image** pipeline — its options type
   requires `optimizeImage`, it needs OIDC auth, and it optimizes rather than
   copies. `copy()` is no help either: it copies within one store. The move has
   to stream: read the old object, `put` it into the new store with
   `multipart: true`. That is what the script does.

5. **Check.** `scripts/_fix/G/probe-hosts.ts` prints the distinct hosts across
   every row carrying a `blobUrl`. When it prints only the new store's host,
   every cut is private. Until then a mixture is *fine* — that is the whole point
   of holding both tokens.

6. **Rollback, at any point:**
   `… migrate-cut-store.ts --rollback --ledger <file> --apply` puts every moved
   row back to the URL in the ledger. The old objects were never deleted, so the
   restore is complete. To back out the deployment as well, **swap the two token
   variables** (primary = old, legacy = new) and set
   `NEXT_PUBLIC_REVIEW_CUT_ACCESS` back to `public` in one redeploy — do not
   simply remove the new token, or the rows already moved lose their store.

7. **Last, and only once the new store has been serving for a while:** delete the
   old store's objects, then the old store, then remove
   `BLOB_READ_WRITE_TOKEN_LEGACY`. Not before — the old objects are the only copy
   of anything step 4 got wrong, **and until they are deleted every public URL
   that has ever left the building still works.** Copying does not revoke
   anything; deleting is what finally does.

---

## 4. The 08:40 window — measured, and now shut in code

`vercel.json` schedules `/api/cron/daily-reconcile` at `40 8 * * *`. Its first
step is `pruneReviewUploads`, whose `release()` helper:

1. set `blobUrl` and `blobPathname` to `null`, **then**
2. `del(blobUrl)`.

That order is deliberate and correct in normal running — there is a comment on
it: *"Bytes go only once the row no longer points at them — a live blobUrl behind
a deleted blob would 302 every viewer to a 404."* It is not the thing to change.

The problem was that **`del()` deletes from the store the TOKEN names, not the
store the URL names**, and it is idempotent about a path it cannot find. During
any window where the token had moved and a row had not: the pointer — the only
record of which object held that cut — was cleared, the delete was aimed at the
wrong store, the bytes were orphaned, and the pass counted it as `pruned`.

Measured against production on 2026-09-17 (`scripts/_fix/G/probe-prune-window.ts`,
read-only, counts only): with `keepUploadsDays = 90`, **0 of the 14 rows were
eligible that day**, and the soonest a row could become eligible was
**2026-09-25** — so a "stop here for a bit" that stretched past a week lost cuts.

**The old answer was a runbook step** (pull the cron entry from `vercel.json`
before the swap, put it back after). **The new answer is in the code:** a
pointer is only cleared once the object has been matched to a token we hold.
Anything else is left whole and counted as `failed`, which is the one outcome
that is recoverable.

Proof, `scripts/_drill/cut-store-prune.ts` — a real PostgreSQL (PGlite on a
loopback socket, schema pushed, `DATABASE_URL` pinned before the first app
import; production is never touched, and the blob token is one for a store that
does not exist so nothing real can be deleted):

```
── THE OLD release() — a faithful copy of the pre-Sep-18 lines
   ours                   blobUrl after: null  <-- the only record of where those bytes are, gone
   foreign store          blobUrl after: null  <-- the only record of where those bytes are, gone
   ours, not a cut path   blobUrl after: null  <-- the only record of where those bytes are, gone

── THE SHIPPED release() — pruneReviewUploads(90) against the same rows
   pruneReviewUploads returned {"pruned":0,"failed":3} in 288ms
   [PASS] ours — pointer cleared, delete aimed  got null
   [PASS] foreign store — row left whole
   [PASS] ours, not a cut path — row left whole
   [PASS] nothing was counted as pruned  got 0
   [PASS] all three accounted for as failed  got 3

── WITH THE LEGACY TOKEN SET — the cutover state the new order creates
   [PASS] a row still in the OLD store is still prunable  got null
   [PASS] …and WITHOUT the legacy token it is left whole, not stranded
```

(The one "ours" delete does reach Vercel and fails — `BlobStoreNotFoundError`,
because the drill's store is invented. That failure is the network confirming
the delete was *aimed*, which is what the test is about.)

`keepUploadsDays` (Settings → Review Room) is still clamped to 1–365 in
`src/lib/settings.ts` and still gates only the first of the prune's three passes;
the other two use a hard-coded 7-day window. Nothing about that changed — it no
longer matters, because the unsafe outcome is now impossible rather than merely
avoided.

---

## 5. The store-id guard, and the signed handoff

`blobFetchDecision` (now in `src/lib/reviewCuts.ts`, still re-exported from
`src/app/api/review/cut/[id]/stream/route.ts` because that is where it shipped
and where `scripts/_fix/G/probe-guard.ts` imports it) decides whether a cut's
object may be fetched and with what. Private host → our token. Public host → no
credential. **Any other store's private host → refused**, because the read-write
token is a bearer credential for one store and the cutover puts two in play.

As it shipped in `f3d70a3` that comparison was **case-sensitive**, and wrong in
exactly the direction that hurts: the store id sits in the token the way the
dashboard writes it (`mphvkCyOMoW88h9w`), while `new URL().host` lower-cases a
hostname and the store's own URLs arrive lower-cased too. It would have refused
**every legitimate cut**, on the one day it is meant to start working. Fixed by
folding case on both sides; §2's fixture table is the proof.

**The signed handoff** is the one thing here with a live result. `fetchableCutUrl`
mints a presigned GET with `issueSignedToken` → `presignUrl`. Asked against the
**real** store with the real token (`probe-store-decisions.ts --live`,
2026-09-18, read-only — it issues a five-minute delegation and prints nothing
but its expiry):

```
--live: asking the control API for a GET delegation on review-cuts/cmtak04sn…
  delegation issued, valid until 2026-09-18T02:31:07.095Z
  presigning a DIFFERENT pathname with it → refused: Blob path does not match
                                            the signed token scope; expected …
```

So: the control API **does** issue read delegations for our store with the token
we hold, and the delegation **is** scoped to one pathname — a link handed to
Dropbox or Meta cannot be replayed against another client's video. What has
**not** been shown, and cannot be until the store exists, is a private object
actually being fetched with one.

---

## 6. What has never been executed

Stated plainly, because the previous version of this file did not:

- No private store has been created. **Every private-store behaviour below the
  SDK's own types is a design, not a result.**
- No blob has ever been uploaded with `access: "private"` from this codebase,
  so it is not known that the browser's PUT succeeds, that `NEXT_PUBLIC_REVIEW_CUT_ACCESS`
  and the token flipping together is sufficient, or what the control plane says
  if they disagree.
- No presigned URL has ever been **fetched** — only issued (§5).
- No object has ever been copied between stores. `migrate-cut-store.ts` has been
  dry-run against the 14 real rows and has never been run with `--apply`.
- No rollback has been exercised.
- The private read path in the stream proxy (`authorization: Bearer …` against
  `*.private.blob.vercel-storage.com`) has never returned a byte. Playback with
  seeking, authorised download, the Dropbox copy, a Topaz render and a prune are
  all **proven on the public store and designed for the private one.**

## 7. Until the store is replaced

Every URL that has already left the building is still live and cannot be
revoked. Treat any cut URL in a Slack message, an email or a browser history as
a working link to an unreleased client video until the old store's objects are
deleted (step 7).
