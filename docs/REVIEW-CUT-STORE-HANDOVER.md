# Handover — replacing the review-cut store with a private one (RTP-01)

**Status: NOT DONE. Nothing in this document has been performed.** The private
store does not exist, so **no code path in this repo has ever fetched a private
blob**. Everything below about how a private read behaves is read off the
installed SDK (`@vercel/blob` 2.8.0) and off Vercel's documented URL shape — it
is a plan, not a result. **The first private upload is the first test.** Treat
step 5 as an experiment with editors' work in it, and do it on a day someone is
watching.

Last measured 2026-09-17. Probes: `scripts/_fix/G/` (read-only) and
`scripts/_agent/G-media/` (read-only).

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

What has already been done in code:

- **Playback no longer hands anyone the object's address.** `/api/review/cut/<id>/stream`
  proxies the bytes behind the hub's own gate, and the client payload carries
  `hasHubCopy` (a boolean) instead of the URL. Zero store URLs remain in
  `ReviewSubmission.assetUrl` / `assetPath` / `finalPath`, in `MediaNote.assetUrl`,
  or in `ProjectMessage` bodies.
- **New uploads cache for 60 seconds, not 30 days**, so the CDN stops answering
  for a re-homed URL within a minute.
- **The hub's half of the flip is a setting**, not an edit: `CutUploader` reads
  `NEXT_PUBLIC_REVIEW_CUT_ACCESS`.

What cannot be done in code: **`access` is the browser's word.** The SDK writes
it as the `x-vercel-blob-access` header on the browser's own PUT
(`createPutHeaders`), and `onBeforeGenerateToken` returns a `Pick<>` of seven
keys that has no `access` in it. The store itself has to be **replaced** with one
created private — an account action, in the Vercel dashboard, by a human.

---

## 2. The order to do it in

> **The order previously circulated — "swap `BLOB_READ_WRITE_TOKEN` to the new
> store, then STOP HERE while the rest lands" — is wrong and must not be used.**
> Section 3 explains what it destroys.

The rule that makes the order safe: **no row's `blobUrl` may ever name a store
that `BLOB_READ_WRITE_TOKEN` does not own — not for a day, not for an hour.**
Every blob command (`put`, `putFromUrl`, `del`, `head`, `list`) accepts an
explicit `token` option, so a migration script can hold *both* tokens at once
while the deployment's environment still holds only the old one. That is what
keeps the window closed.

1. **Create the new store, private, in the Vercel dashboard.** Copy its
   read-write token somewhere local. **Change nothing in the project's
   environment variables yet.**
2. **Move the objects, from a local script, with both tokens passed explicitly.**
   For each of the 14 rows carrying a `blobUrl`: `putFromUrl(pathname, oldUrl,
   { access: "private", token: NEW_TOKEN, addRandomSuffix: false })` — the new
   store fetches the old object, which is still public, so this works precisely
   because the migration happens *before* anything is locked down. Then update
   that row's `blobUrl` / `blobPathname` to the new object **in the same pass**.
   Do not delete anything from the old store yet (house rule: retire, don't
   delete). *Untested: `putFromUrl` across stores has not been run here.*
3. **Check: zero rows still pointing at the old store.** `scripts/_fix/G/probe-hosts.ts`
   prints the distinct hosts across every row carrying a `blobUrl`; it must print
   the new store's host and nothing else. If any row still names the old store,
   **stop** — going on from here is exactly the failure in section 3.
4. **Now swap `BLOB_READ_WRITE_TOKEN`** in Vercel to the new store's token, and
   redeploy. Playback is the thing to check first: the stream route sends the
   token only to our own store's private host, so a cut should play as it did
   yesterday. It has never been observed doing so (see the top of this file).
5. **Only then set `NEXT_PUBLIC_REVIEW_CUT_ACCESS=private`** and redeploy, so new
   uploads land private. Flipping it before step 4 stops every editor's upload
   the same minute: private access against a public store is refused by the
   control plane ("Cannot use private access on a public store").
6. **Work through section 4** — several things outside the Review Room hand this
   URL to somebody else's servers and will break the moment it stops being
   public. At least one of them (4.1) refuses the upload itself.
7. **Last, once the new store has been serving for a while:** delete the old
   store's objects, then the old store. Not before — the old objects are the only
   copy of anything step 2 got wrong.

### If it cannot be done in one sitting

There is no setting that turns the prune off. `keepUploadsDays` (Settings →
Review Room) is clamped to 1–365 in `src/lib/settings.ts:247` — it cannot be set
to "never" — and it gates only the *first* of the prune's three passes; the other
two use a hard-coded 7-day window and ignore it entirely.

**The switch is the cron entry.** Remove

```json
{ "path": "/api/cron/daily-reconcile", "schedule": "40 8 * * *" }
```

from `vercel.json` and redeploy *before* the token is swapped, and put it back
after step 3 confirms every row has moved. That route also carries photo counts,
the Plaid retry, package margins and the growth plan — all of them are catch-up
work that costs nothing to miss for a day or two.

---

## 3. What the old order destroyed (the 08:40 window)

`vercel.json` schedules `/api/cron/daily-reconcile` at `40 8 * * *`. Its **first**
step is `pruneReviewUploads` (`src/lib/reviewCuts.ts:935`), whose `release()`
helper, at `src/lib/reviewCuts.ts:952`:

1. sets `blobUrl` and `blobPathname` to `null`, **then**
2. calls `del(blobUrl)`.

That order is deliberate and correct in normal running — there is a comment on it:
*"Bytes go only once the row no longer points at them — a live blobUrl behind a
deleted blob would 302 every viewer to a 404."* It is not the thing to change.

But `del()` deletes from the store that **`BLOB_READ_WRITE_TOKEN`** names, not
from the store the **URL** names. So during any window in which the token has
been swapped and the rows have not:

- the row's pointer is cleared — irreversibly, it is the only record of which
  object held that cut;
- the delete is aimed at the *new* store, so the bytes stay in the *old* one,
  now unreferenced and unreachable by anything in the hub;
- and it is silent. `del()` is idempotent about a path it cannot find, so the
  prune counts it as `pruned`, not `failed`, and nothing is logged.

**Measured against production on 2026-09-17** (`scripts/_fix/G/probe-prune-window.ts`,
read-only, counts only):

```
keepUploadsDays = 90
rows carrying a blobUrl today                     : 14
  step 1 approved + copied, past retention        : 0
  step 2 UPLOAD_FAILED, bytes landed, >7d         : 0   <-- keepUploadsDays does NOT gate this
  step 3 superseded/withdrawn round, >7d          : 0   <-- nor this
  rows the next 08:40 pass would release          : 0 (up to 50 per step)

soonest a row now holding bytes can become eligible:
  2026-09-25  step 3 superseded (once a newer round exists)
```

Read that honestly: **today the window would eat nothing**, and on **2026-09-25**
it starts eating rows — and any cut uploaded and superseded from today is
eligible seven days later. A "stop here for a bit" that stretches past a week
loses cuts. That is why the order above closes the window instead of timing it.

---

## 4. What breaks the day the store goes private

Each of these hands the cut's URL to **somebody else's servers**, which have no
session and no token. "Server-side" does not mean "authenticated" — it matters
*whose* server does the fetching.

**4.1 The upload's own finalize refuses — fix this first.**
`src/app/review/actions.ts:1152` (`finishCutUpload`) requires the URL to match
`^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/`. On a private store
the browser's finish call answers *"That file doesn't belong to this cut."* The
store's own completion callback (`finalizeCutUpload`, `src/lib/reviewCuts.ts:653`)
has no such check and would still file the row — so the outcome is a race, and
what the editor sees is an error on a cut that may or may not have landed.

**4.2 Instagram publishing — the reel never gets fetched.**
`src/lib/publishing.ts:649` passes `videoUrl: cut.blobUrl` into
`createMediaContainer`, which at `src/lib/integrations/instagram.ts:303` posts it
to Meta's Graph API as `video_url`. **Meta's servers fetch that URL**, from
Meta's network, with no credential of ours. A private object answers them with a
401/403 and the container is never created: the publish job fails or retries
until it stops. Nothing in the hub logs "Meta could not read the file" in those
words — it surfaces as a failed publishing job. (The 2026-09-17 handover missed
this one entirely. Publishing is outside this group's files; it is named here so
whoever does the flip knows to fix or gate it.)

**4.3 The Dropbox copy on approval.**
`src/lib/reviewCuts.ts:837` calls Dropbox `files/save_url` with `sub.blobUrl`.
**Dropbox's servers** fetch it. Approvals would stop filing the copy that is
supposed to become the file of record.

**4.4 Topaz and the duration probe.**
`src/lib/topazJobs.ts:1007` fetches `sub.blobUrl` directly, and
`probeVideoMetadata` range-probes it (also reached from
`src/lib/aryeoDelivery.ts:974` to measure a cut's length). Both are plain
unauthenticated fetches from our own server process — they can be given the
token, but somebody has to give it to them.

**4.5 Both delete guards refuse to delete anything.**
`src/app/review/actions.ts:1201` (`abandonCutUpload`) and
`src/app/review/actions.ts:1702` (remove-a-cut) each match a hard-coded
`\.public\.`. On a private store they stop deleting and start reporting the file
"left behind" — safe, but wrong, and it accumulates.

**4.6 Transcription, when it is turned on.**
`src/lib/cutTranscripts.ts:459` hands `cut.blobUrl` to a speech-to-text provider,
whose servers fetch it. Dormant today (no key, switch off) — it becomes 4.2 all
over again the day it is configured.

Only one path is already correct: `/api/review/cut/<id>/stream`, which fetches
the object **from our own server** and attaches
`authorization: Bearer <read-write token>` — but only for our own store's private
host. See section 5.

---

## 5. The store-id guard, and the bug it had

`blobFetchDecision` in `src/app/api/review/cut/[id]/stream/route.ts` decides
whether a cut's object may be fetched and with what. Private host → our token.
Public host → no credential. **Any other store's private host → refused**, because
the read-write token is a bearer credential for one store and the migration puts
two stores in play at once.

As it shipped in `f3d70a3`, that comparison was **case-sensitive**, and it was
wrong in exactly the direction that hurts: the store id sits in the token the way
the dashboard writes it (`mphvkCyOMoW88h9w`), while `new URL().host` lower-cases
a hostname before anyone sees it, and the store's own URLs arrive lower-cased too
— all 14 production rows read `mphvkcyomow88h9w.public.blob.vercel-storage.com`.
`mphvkCyOMoW88h9w` never equals `mphvkcyomow88h9w`, so the guard would have
refused **every legitimate cut**, on the one day it is meant to start working.

Fixed by folding case on both sides. Proof, `scripts/_fix/G/probe-guard.ts`
(read-only; it imports the shipped function and runs it against the real token
and the real rows, with the host rewritten to `.private.` to stand in for the
store that does not exist yet):

```
production rows carrying a blobUrl: 14
  today (public URLs), new guard allows : 14/14  (no authorization header sent)
  same objects as .private., OLD guard  : 0/14 allowed  <-- the blocker
  same objects as .private., NEW guard  : 14/14 allowed, with Bearer <our token>

fixtures (does the token leave the building?)
  our store, private, lower-case host    ALLOWED + token
  our store, private, UPPER-CASE host    ALLOWED + token
  our store, public                      ALLOWED, no token
  ANOTHER store, private                 REFUSED (foreign-store)
  look-alike domain                      REFUSED (unreadable)
  not a url                              REFUSED (unreadable)
```

A look-alike domain (`…blob.vercel-storage.com.evil.test`) is refused, and a
genuine-but-foreign store is refused with the host in the log and a generic
sentence to the viewer.

---

## 6. Until the store is replaced

Every URL that has already left the building is still live and cannot be
revoked. Treat any cut URL in a Slack message, an email or a browser history as
a working link to an unreleased client video until the old store's objects are
deleted (step 7).
