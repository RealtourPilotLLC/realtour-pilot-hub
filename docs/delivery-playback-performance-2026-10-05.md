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

## Release receipt
- Application committed and fast-forward pushed/read back on GitHub main: `29def363a9ad30d3185d59ace706d977b3893505`. Branch `codex/audit-2026-09-30`.
- Production READY `dpl_2iz43ZYumng8CSMheXLeJUqzPAfD`, exact committed-source archive `/private/tmp/rtp-playback-release-x033wfdz/source`. Remote optimized build/types passed; CLI inspect confirms https://hub.realtourpilot.com and existing Hub aliases. Build2m21s. No environment/private files included.
- Public HTTP smoke: unauthenticated Home307/0.36s and login200/0.81s. These are not authenticated page-load benchmarks.
- Live authenticated playback remains UNVERIFIED: reproduction of the old media Next Link hung owned production tab42; navigation/screenshot to production then timed out on owned43/44. Supported browser recovery attempted; local fixture playback completed in43 before navigating production. No unsupported alternate browser control used. Next: fresh supported browser session, sign in if needed, open delivery Watch and verify real processed-video play/seek; capture screenshot and compare authenticated Home/Editing load times. Physical iPhone Safari remains separate acceptance.
- All implemented changes enabled in existing authorized staff UI. No client audience/automation switch changed. Portal remains TEST_ONLY.
- Owned fixture PID90088 terminated through its cleanup handler:23 assertions passed/0failed, intentional serve exit143; ports3225/5617/5618 no listeners. Old3215/3216 processes preserved. Build/deploy complete; no pending approval.
- Rollback: previous application `be29cea3997475fb855ae14b98642481fb741e97`, deployment `dpl_HgEkoTTUidUVEf22g5oALbyLbrmF`; application-only, no database rollback needed.
