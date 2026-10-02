# October client launch and production handoff

## Current release

Application `9292beee1a15cb9ff4cf8caae04f2be41e1ec13d` is deployed to production.
Editor brief, Editing Room, exact final-file delivery, notice context, client
downloads, shared controls, appointment controls and Brand Profile improvements
are implemented, tested, committed and deployed. Production automation remains
`[]`, audience `TEST_ONLY (default)`, users2/memberships3. Deployment does not
activate automation or invite the named clients. Rollback to11b4a67 preserves
current database and newer writes. See the release matrix for source/test receipts.

## Local Home and Settings label-wrapping changes — October 2

Applied locally on top of `9292beee1a15cb9ff4cf8caae04f2be41e1ec13d`:

- Home block headings allow the title and Now badge to wrap. Pipeline and shoot
  headers wrap their metadata/actions; project titles and client names display
  their full text instead of ellipsis. Long titles, names and editor labels can
  break within a word when necessary.
- Settings content allows long text to wrap within its available width. The
  People/access and financial link text can shrink beside the fixed arrow.
- Changes are limited to `src/app/page.tsx` and `src/app/settings/page.tsx`.
  Node 20 changed-file ESLint and `git diff --check` passed.

These changes are uncommitted and undeployed. Actual 200% browser zoom has not
been verified; the acceptance gate below remains open. Check Home block headings,
pipeline/shoot rows and client names, then expanded Settings sections and link
rows with long labels at actual 200% zoom. Confirm full labels remain readable,
actions usable and no horizontal clipping occurs. Self-QC and client script/video
views remain outside this local change.

## What remains before real-client onboarding

| Owner | Required evidence / concrete next step | Current disposition |
|---|---|---|
| Engineering + Jordan, actual iPhone/Android | Use the isolated normal client session and declared media: partial/mixed upload including unfilmed topics, interrupt/retry and verify exact receipt; approve the exact test final then download/share/save and watch the whole rendition. Record device/browser/version and actual result. | Desktop/browser and causal upload/download tests pass; actual phone behavior and full-watch are unaccepted. |
| Kyle + James + Jordan | Use the isolated normal role sessions. Start on Home; identify next owned action without narration. Kyle opens exact ready delivery and distinguishes final handoff from client notice. James opens exact current cut and revision instructions. Record hints/time, then review the actual existing work read-only. | Role screens, queue counts, filters, exact links and failure recovery pass; no invented human usability score. |
| Kyle + Kim | Reconcile Sarina's owed/source footage and exact applicable sessions first. Kim identifies the footage, scope and current brief without Jordan relaying it; preserve manual Start/Pause. | UI/sibling context and receipt tests pass; source-dependent real handoff remains open. |
| Jordan + engineering | Separately authorize a specific disposable provider/model test if needed: create/read-back/reschedule/cancel, source-grounded model output and exact real rendition/audio/Dropbox/portal bytes. | Fake-provider causal evidence is retained. Real sends, bookings, AI activation and financial changes remain unauthorized. |
| Jordan + Kyle | Resolve exact canonical/source holds below; prepare current month, reviewed strategy/topics/brand and access seats through existing gates. Review rollout separately. | Named roster settled; no invites, merges, regeneration or audience activation performed. |
| Kyle/James + engineering | Actual200% browser zoom on Home, Self-QC, client script/video and Settings, with a long label; verify no clipping and usable actions. | Native widths and measured two-theme contrast pass. Supported automated zoom keys did not change actual scale; that attempt is not credited. |

Physical/device, staff, provider and source gates are H01–H04 in the acceptance
map. Each is separate from software implementation and production deployment.

## Named October roster — prepared only

Jordan's facts: only Joe/Joseph Sutow completed this month's strategy call.
Rich Schultz filmed; Ashley Brunner has not. The general welcome strategy link
is https://calendly.com/realtourpilot-info/strategy-call. It does not overwrite
the separately saved monthly scheduling configuration. No welcome was sent.

| Person | Cohort | Kyle/Jordan's next preparation step |
|---|---|---|
| Erica Walker | Regular | Verify why an October COMPLETED call points to September24; retain the original transcript/status, resolve month purpose before routine October follow-up. |
| Kristin Ciarmella | Regular | Verify October COMPLETED versus September25 source; retain original evidence and resolve month purpose. |
| Arielle Roemer | Regular | Prepare October call/planning and current source/strategy/bank/access evidence; preserve existing content. |
| Bernadette Rabel | Regular | Prepare October call/planning and current source/strategy/bank/access evidence. |
| Joe / Joseph Sutow | Regular, one person | Select canonical of two active enrollments using exact contact/subscription/history; locate completed October call. Do not request another call or merge automatically. |
| John Collins | Regular | Prepare October call/planning and current source/strategy/bank/access evidence. |
| Marcee McMullen | Regular | Prepare October call/planning and current source/strategy/bank/access evidence. |
| Mike Flatley | Regular | Prepare October call/planning and current source/strategy/bank/access evidence. |
| Janice Pigga | Regular | Verify ACTIVE versus ENDED candidate and exact source; preserve ended history and prior source conflict. |
| Mike Ciunci | Regular | Preserve saved WRITTEN_SELECTED/NOT_REQUIRED route; plan any desired October call separately without silently making it a required preparation gate. |
| Ashley Brunner | Trial, not filmed | Prepare October planning and filming prerequisites; preserve trial allowance/billing. |
| Rich Schultz | Trial, filmed | Verify Rich against Rick and don't-use candidates from exact contact/shoot evidence; then prioritize existing edit/review/final delivery. Do not create another shoot. |

Exact private IDs and ordinary staff month links are in
`/private/tmp/ops-hub-october-named-roster-2026-10-02/readiness.private.md`.
That saved read-only report returned0unrevoked seats,0released strategies and
0approved visible topics for these candidates. It does not prove all historical
or draft material absent. Early first-call portal access can legitimately precede
strategy release; do not invent a universal new seat gate. The former browser
block in that dated report is superseded: supported native access is restored.

## Exact video production handoff

1. Kyle opens the existing monthly output and current session/source scope.
   The brief identifies output, approved script version, brand/current receipt,
   footage, requested changes, owner and due basis. Unresolved source linkage
   remains an internal repair; do not infer it from a name or timestamp.
2. Kim uses manual Start/Pause, uploads the actual cut and completes file-bound
   Self-QC. A receipt is an acknowledgment, not an automatic Start/upload block.
3. James reviews the exact current cut and requested revision; verdict and
   revision instructions remain tied to that file/version.
4. Kyle checks final rendition and exact final Dropbox backup, then hands that
   exact monthly output to the portal. Listings retain their Aryeo route.
5. Handoff, client notification and exact client approval are separate facts.
   UNKNOWN notice outcomes remain held for reconciliation; no blind retry.
6. Client download evidence distinguishes started, completed and Saved; it does
   not assert Photos-save or whole-video viewing. A pending/unapproved exact
   version remains gated. Preserve old versions and comments.

## Restrictions and resume

No real client messages/invitations, provider bookings, financial changes,
worker activation, audience expansion, schema changes, data reset/seed or Git
push. Deploy verified application checkpoints under the standing authorization.
Use the current resume file and finite acceptance map; retain completed evidence.
No broad audit or exhaustive role-by-route failure matrix is required.
