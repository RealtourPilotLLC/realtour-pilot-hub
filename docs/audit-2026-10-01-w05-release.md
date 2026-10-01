# W05 exact provider-echo checkpoint — production release

Application `4354aca113ef75e0c17fe72f42c1b33e42541973` is live at
https://hub.realtourpilot.com. Ready `dpl_JAen2oGKAa4ZLunmbZzrz1u1kcNp`,
promoted October1 at17:15:02Z (1:15 PM EDT), under the user's checkpoint-release
request. Previous cache checkpointa38715d is rollback.

## Implemented and tested

Only an authenticated outgoing delivered webhook from the existing workspace
line with one exact recipient/body, original provider ID/time and no media can
settle a single attempted unknown delivery intent. Other matching history,
changed identity, already-used provider ID, unsigned/missing/stale facts, group/
media and nonunknown rows remain held. Provider time cannot precede intent
creation. Serializable reads and CAS preserve one proof per intent and dedupe.
Recovery sends nothing. Provider acceptedAt prevents notice coverage for cuts
sent later. The historical manual matcher remains unchanged.

Actual configured/bad-token/unsigned Next POST plus real disposable PostgreSQL
identity, concurrency and notice-window fixture:36/0. Focused review repaired
and retested the pre-intent-time edge. Non-incremental TypeScript0, scopedlint0,
clean isolated Node20 build0 and protected Vercel build/exact stage checks pass.
Canonical exact version, login, six assets, office/portal auth, anonymous final
refusal and old-host redirect pass. Log
`/tmp/w05-delivery-echo-recovery-final-source/`; private release receipts in
`/private/tmp/ops-hub-w05-release-4354aca-2026-10-01` (0700/0600).

## Deployed, enabled and client-visible

Source is deployed. A bounded SELECT-only prerequisite check confirms the
existing OpenPhone webhook token is usable with the local saved encryption key;
no token/provider configuration changed. The path is available for future
verified callbacks under existing configuration. Real callback/delivery
observation is not claimed; no old event was replayed and no message was sent.
Manual settlement authority is unanswered and absent from this change.

Read-only comparisons prove automation, rollout TEST_ONLY, raw seat totals and
saved business settings unchanged. Seven existing Aryeo operational idempotency/
reconciliation markers changed while live business continued; prefixes/counts
are recorded in sanitized evidence. This is not described as a frozen database
or all AppSetting values unchanged. No agent financial or provider action was
performed. No schema/reset/seed/live mutation test, client send/invite, booking,
activation, rollout expansion or Git push.

Mounted browser/phone/provider/media and complete real-client journey remain
unaccepted. U0–U5 partial/U6 open. C14 Home's unreadable exception fallback has
its own reviewed14/0 source repair, not included in4354aca. Fresh launch inventory
still has13 candidates/13 October workspaces but zero eligible real seats,
released strategies or approved canonical topics; first roster and staff source
reconciliation remain gates. Browser tool policy blocks supported tab access.

## Recovery

Promote the previous verified a38715d deployment if rollback is necessary.
Preserve additive tables, receipts, provider IDs/dedupe and all newer business
writes; never restore the stale backup over live changes. Private config probe
prints only a boolean, never credentials. Sanitized receipts:
`release-evidence/2026-10-01-w05-release.json`.
