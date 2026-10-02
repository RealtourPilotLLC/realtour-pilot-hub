# W05 — durable authenticated delivery proof

## Implemented, tested, committed and deployed

Checkpoint `d22c5823643fd223e7ed61a5f84affdfe4a64e5f` is live at
https://hub.realtourpilot.com, Ready `dpl_DtWVEc8NjExmdsdtgT54sXTrQnMC`,
promoted Oct1 8:23:28 PM EDT (Oct2 00:23:28Z). Clean exact Node20 build,
Vercel remote build, protected stage, canonical version/login/six assets,
office/client anonymous permissions, final403 and old-host307 all pass.
Guarded read-only comparison confirms all saved settings, automation OFF/
TEST_ONLY and raw seat counts unchanged. Sanitized evidence:
`release-evidence/2026-10-01-durable-proof-release.json`. Previous ab6cfdf is
rollback; preserve all receipts/provider identities/dedupe and newer DB writes.

An authenticated exact delivery echo could be marked PROCESSED despite a
transient settlement failure. A later stored replay also lost the authentication
context. The existing attempted unknown delivery intent then remained held.

- The receiver atomically stores its raw WebhookEvent and an authentication
  receipt in existing AuditLog. The receipt binds exact row identity, provider,
  event type, external identity and raw payload by SHA256; it copies no secret,
  token or message text. There is no schema change or legacy proof backfill.
- Stored replay trusts only an unchanged authenticated receipt. Missing,
  unsigned, altered and malformed proof cannot settle a delivery.
- Operational settlement, receipt-read and unavailable workspace-line failures
  remain retryable. Automatic receipt failure uses existing per-event backoff
  and continues unrelated events. Cold-process line failure retains ERROR.
- A processed unsigned twin cannot consume authenticated proof. Recovery keeps
  the original intent, provider time, dedupe and attempt count; it never sends
  another text. Ambiguous business evidence remains held.

Actual POST, stored manual/automatic replay, fresh-process reconstruction,
isolated read failure, unrelated-event progress, cold workspace-line failure,
atomic receipt rollback, tampered/missing/unsigned proof and notice-time checks
pass **25/0** on disposable real PostgreSQL. Existing exact-echo concurrency/
notice regression passes **36/0**. Provider calls are fake/fenced; no production
mutation tests. Logs: `/tmp/w05-durable-proof-reviewed/`.
Whole-tree nonincremental Node20 types and scoped lint pass. One focused peer
review identified the two isolation/line issues above; its narrow correction
check is clear, with no residual defect found in these paths.

No client send, invitation, booking, financial action, automation activation,
rollout change, new schema or pushed branch. Production callback acceptance and
manual unknown-text settlement authority remain open. This extends deployed4354aca
exact-evidence recovery, without granting new manual policy.

Existing authenticated callbacks can use this recovery under unchanged gates.
No client audience, outbound automation or switch was enabled; real callback
acceptance is not claimed. First CALL-month causal HTTP evidence now passes14/0
against the unchanged journey code in compiledab6cfdf; providers/media remain
fake and returning-editor extension is in progress separately.
