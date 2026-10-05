# Delivery playback and loading — October 5, 2026

## Scope / checkpoint
User reports slow/nonworking delivery Watch and generally slow screens. Starting clean `8bb5c16a8f95fed7ee3d9d964e6bde5419589631`, branch `codex/audit-2026-09-30`; previous deployed application `be29cea3997475fb855ae14b98642481fb741e97`, READY `dpl_HgEkoTTUidUVEf22g5oALbyLbrmF`. Prior audit/portal holds remain in `editor-review-delivery-audit-2026-10-05.md`.

## Implemented
- Delivery Watch used Next Link to a media endpoint. Reproduced non-navigation/hung browser on production. Replace with immediate native modal player, mobile containment, exact-version grouped selector, close/unmount/focus restoration, bounded loading feedback and retry.
- After existing authorization/current-cut/fingerprint/Dropbox metadata checks, `play=1` redirects to the temporary Dropbox link. Avoid repeated serverless byte proxy and database/provider checks on seeks. Ordinary final-check proxy and private original-media protection unchanged. Watching never records upload/delivery/check evidence.
- Batch final-cut and destination reads instead of per-video queries; parallel independent delivery, Editing Room and Home reads. All mutations still recheck live permissions/exact versions.
- Opt-in read-only aggregate diagnostic `scripts/_live/page-performance.ts`, connection read-only proven before queries. No schema/index changes or production data repair.

## Verification
- 172 focused behavioral checks: monthly-final56, branding-destination36, editing-queue17, office-status41, Home-scope22. Home rerun after last scheduling edit passes. Updated a stale Home assertion referring to a previously removed ReviewRoom panel; retained real+fixture scope checks.
- Full TypeScript, scoped ESLint, optimized build and diff checks pass. One focused source review.
- Isolated actual-page fixture composition23 assertions. Native browser390px: player318px, modal opens approximately311ms; sample reaches readyState4/end with no media error. Both grouped videos play. Two disposable upload acknowledgements combine into one Not Sent item. Stale fingerprint gives error/retry; Escape unmounts video and returns focus. No real provider/client action. Physical iPhone Safari remains separate acceptance.
- Local-to-live read-only loader timings (one before/after comparison, not full-page benchmarks): delivery1888→1218ms (45→40queries); Editing1970→1571ms (47queries); review972→890ms; exceptions2422→2317ms; pipeline859→867ms. Database simple roundtrip ~55ms. No claim every screen is instant; exceptions remain a measurable slow path.
- Evidence `/private/tmp/rtp-performance-{before,after}-2026-10-05.json`, `/private/tmp/rtp-watch-performance-drills-2026-10-05-run2`, `/private/tmp/rtp-watch-home-final-2026-10-05`, `/private/tmp/rtp-watch-performance-build-2026-10-05.log`, `/private/tmp/rtp-delivery-preview-mobile-fixture-2026-10-05.png`.

## Release / remaining
Commit, main push, production READY and authenticated read-only playback receipt to follow. No messages, invitations, real provider sends/uploads, financial changes or automation/portal rollout activation. Portal remains TEST_ONLY with previously documented launch holds. Preserve manual Start/Pause, exact versions and settings.
